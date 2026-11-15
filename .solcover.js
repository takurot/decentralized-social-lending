module.exports = {
  configureYulOptimizer: true,
  istanbulReporter: ['html', 'lcov', 'text', 'json-summary'],
  skipFiles: ['mocks/', 'interfaces/']
};
