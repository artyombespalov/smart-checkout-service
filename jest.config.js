/** @type {import('jest').Config} */
process.env.ORDERS_TABLE = 'test-orders-table';
process.env.AWS_REGION = 'us-east-1';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
};
