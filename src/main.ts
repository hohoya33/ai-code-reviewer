import { readFileSync } from "fs";
import * as core from "@actions/core";
import { GoogleGenAI, ApiError } from "@google/genai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const GOOGLE_GENAI_API_KEY: string = core.getInput("GOOGLE_GENAI_API_KEY");
const GOOGLE_GENAI_MODEL: string = core.getInput("GOOGLE_GENAI_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const genAI = new GoogleGenAI({
  apiKey: GOOGLE_GENAI_API_KEY,
});

const MAX_GENAI_RETRIES = 3;
const BASE_BACKOFF_DELAY_MS = 1_000;

class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

type ReviewComment = { body: string; path: string; position: number };
type DiffChange = Chunk["changes"][number] & {
  add?: boolean;
  normal?: boolean;
  ln?: number;
  ln2?: number;
};

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];

  for (const file of parsedDiff) {
    if (!file.to || file.to === "/dev/null") continue; // Ignore deleted files
    const linePositionMap = buildLinePositionMap(file);

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, aiResponse, linePositionMap);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

type GenAIError = ApiError | (Error & { status?: number });

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

function getStatusCode(error: GenAIError): number {
  if (error instanceof ApiError) {
    return error.status;
  }
  return typeof error.status === "number" ? error.status : 0;
}

function isQuotaError(error: GenAIError): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const status = getStatusCode(error);
  if (message.includes("quota") || message.includes("billing")) {
    return true;
  }
  return status === 429 && message.includes("exceed");
}

function isRetryableError(error: GenAIError): boolean {
  if (isQuotaError(error)) {
    return false;
  }
  return transientStatuses.has(getStatusCode(error));
}

function getErrorMessage(error: GenAIError): string {
  return error.message ?? "Unknown Google GenAI error";
}

function getBackoffDelayMs(attempt: number): number {
  const jitter = Math.random() * 200;
  return BASE_BACKOFF_DELAY_MS * Math.pow(2, attempt) + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const requestPayload = {
    model: GOOGLE_GENAI_MODEL,
    contents: prompt,
    config: {
      temperature: 0.2,
      maxOutputTokens: 700,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      responseMimeType: "application/json",
    },
  };

  for (let attempt = 0; attempt <= MAX_GENAI_RETRIES; attempt++) {
    try {
      const response = await genAI.models.generateContent(requestPayload);
      const res = response.text ?? "{}";
      return JSON.parse(res).reviews;
    } catch (error) {
      const genAIError = error as GenAIError;

      if (isQuotaError(genAIError)) {
        throw new QuotaExceededError(
          "Google GenAI quota was exceeded. Please check your plan, billing details, or provide a key with sufficient quota."
        );
      }

      const shouldRetry = isRetryableError(genAIError);
      const isLastAttempt = attempt === MAX_GENAI_RETRIES;

      if (!shouldRetry || isLastAttempt) {
        console.error("Error:", genAIError);
        return null;
      }

      const delayMs = getBackoffDelayMs(attempt);
      core.warning(
        `Google GenAI request failed (attempt ${attempt + 1}/${
          MAX_GENAI_RETRIES + 1
        }): ${getErrorMessage(
          genAIError
        )}. Retrying in ${Math.round(delayMs)}ms...`
      );
      await delay(delayMs);
    }
  }

  return null;
}

function createComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>,
  linePositionMap: Map<number, number>
): ReviewComment[] {
  const path = file.to;
  if (!path) {
    return [];
  }

  return aiResponses.flatMap((aiResponse) => {
    const lineNumber = Number.parseInt(aiResponse.lineNumber, 10);
    if (!Number.isFinite(lineNumber)) {
      core.warning(
        `Skipping comment for file ${file.to}: invalid line number "${aiResponse.lineNumber}".`
      );
      return [];
    }

    const position = linePositionMap.get(lineNumber);
    if (typeof position !== "number") {
      core.warning(
        `Skipping comment for file ${file.to}: unable to map line ${lineNumber} to diff position.`
      );
      return [];
    }

    return {
      body: aiResponse.reviewComment,
      path,
      position,
    };
  });
}

function buildLinePositionMap(file: File): Map<number, number> {
  const linePositions = new Map<number, number>();
  let position = 0;

  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      position += 1;
      const newLineNumber = getNewLineNumber(change);
      if (
        typeof newLineNumber === "number" &&
        !linePositions.has(newLineNumber)
      ) {
        linePositions.set(newLineNumber, position);
      }
    }
  }

  return linePositions;
}

function getNewLineNumber(change: DiffChange): number | null {
  if (change.add && typeof change.ln === "number") {
    return change.ln;
  }

  if (change.normal && typeof change.ln2 === "number") {
    return change.ln2;
  }

  return null;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[]
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  if (error instanceof QuotaExceededError) {
    core.setFailed(error.message);
    return;
  }

  console.error("Error:", error);
  process.exit(1);
});
