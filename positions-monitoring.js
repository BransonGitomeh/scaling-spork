require('dotenv').config();
const Binance = require("node-binance-api");
const chalk = require('chalk');
const { BINANCE_API_KEY, BINANCE_SECRET_KEY } = process.env
const binance = new Binance().options({
  APIKEY: BINANCE_API_KEY,
  APISECRET: BINANCE_SECRET_KEY,
});
const mathjs = require('mathjs');

async function getOpenFuturesPositions() {
  try {
    console.log('Futures position monitor running...');
    const positions = await binance.futuresPositionRisk();
    // console.log(positions); // Debug: Print the entire response to verify the data structure

    // Filter positions to get only those that are open (positionAmt !== 0)
    const openPositions = positions.filter(
      (position) => mathjs.number(position.positionAmt) !== 0,
    );

    if (openPositions.length > 0) {
      openPositions.forEach((position) => {
        const symbol = position.symbol;
        const size = mathjs.abs(parseFloat(position.positionAmt));  // Absolute position size
        const entryPrice = parseFloat(position.entryPrice);  // Entry price of the position
        const markPrice = parseFloat(position.markPrice);  // Current market price
        const liqPrice = parseFloat(position.liquidationPrice);  // Liquidation price
        const leverage = parseFloat(position.leverage);  // Leverage used
        const unrealizedProfit = parseFloat(position.unRealizedProfit);  // Unrealized profit or loss
        const notional = parseFloat(position.notional);  // Total position value
        const maxNotionalValue = parseFloat(position.maxNotionalValue);  // Max allowable position size
        
        // Margin Calculation: Margin is the amount of capital required to open the position
        const margin = mathjs.divide(mathjs.abs(notional), leverage);  // Margin used for the position
        
        // Margin Ratio Calculation: The ratio of the margin relative to the maximum notional value
        const marginRatio = mathjs.multiply(mathjs.divide(mathjs.abs(notional), maxNotionalValue), 100);  // Margin ratio
        
        // PnL Calculation: Based on the difference between the entry price and the mark price, adjusted for leverage
        const pnl = mathjs.multiply(mathjs.subtract(markPrice, entryPrice), size, leverage);  // Total profit/loss
        const pnlPercentage = mathjs.round(mathjs.multiply(mathjs.divide(unrealizedProfit, margin), 100), 2);  // PnL percentage based on margin
        
        // Correct ROI Calculation: Based on unrealized profit and margin used
        const roi = mathjs.round(mathjs.multiply(mathjs.divide(unrealizedProfit, margin), 100), 2);  // ROI percentage
        
        console.log(`${chalk.bold(symbol)}:`);
        console.log(`  Size: ${chalk.yellow(`${size.toFixed(4)}`)} units`);
        console.log(`  Entry Price: ${chalk.blue(`${entryPrice.toFixed(4)}`)}`);
        console.log(`  Mark Price: ${chalk.green(`${markPrice.toFixed(4)}`)}`);
        console.log(`  Liquidation Price: ${chalk.bgRed(`${liqPrice.toFixed(4)}`)}`);
        console.log(`  Margin Ratio: ${chalk.dim(`${marginRatio.toFixed(2)}%`)}`);
        console.log(`  Margin: ${chalk.dim(`${margin.toFixed(4)} USDT`)}`);
        console.log(`  PnL: ${chalk[pnl > 0 ? 'green' : 'red'](`${pnl.toFixed(2)} USDT`)}`);
        console.log(`  PnL Percentage: ${chalk[pnlPercentage > 0 ? 'green' : 'red'](`${pnlPercentage.toFixed(2)}%`)}`);
        console.log(`  ROI: ${chalk[roi > 0 ? 'green' : 'red'](`${roi.toFixed(2)}%`)}`);
        console.log('------------------------');
        
      });
    } else {
      console.log("No open futures positions found.");
    }
  } catch (error) {
    console.error("Error fetching positions:", error);
  }
}



getOpenFuturesPositions();
setInterval(() => {
  try {
    getOpenFuturesPositions();
  } catch (error) {
    console.error("Error running bot:", error);
  }
}, 1000);
