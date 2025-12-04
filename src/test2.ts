const dummyUsers = [
  {
    id: 1,
    name: '김철수',
    email: 'chulsoo.kim@example.com',
    isActive: true,
  },
  {
    id: 2,
    name: '이영희',
    email: 'younghee.lee@example.com',
    isActive: false,
  },
  {
    id: 3,
    name: '박지성',
    email: 'ji-sung.park@example.com',
    isActive: true,
  },
];

// 더미 설정 객체
const dummySettings = {
  appName: 'Dummy App',
  version: '1.0.0',
  featuresEnabled: {
    featureA: true,
    featureB: false,
  },
};

console.log(dummyUsers);
console.log(dummySettings);
