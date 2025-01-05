const logs = {
    trendLog: [],
    performanceMetricsLog: []
};

function logTrend(data) {
    logs.trendLog.push(data);
    console.log(chalk.yellow(`Trend Log: ${JSON.stringify(data, null, 2)}`));
}

function logPerformanceMetrics(data) {
    logs.performanceMetricsLog.push(data);
    console.log(chalk.red(`
