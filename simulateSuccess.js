const Binance = require('node-binance-api');
const currency = require('currency.js');
const math = require('mathjs');
const moment = require('moment');
require('moment-duration-format');
const chalk = require('chalk');
const chalkTable = require('chalk-table');
require("dotenv").config();

// Constants
const winrate = 0.5; // 70% winrate
const leverage = 75; // 100x leverage
let minNotional = 5.1
let symbol = "DEGOUSDT";

const currencyFormatterUSD = (amount = 0) => currency(amount.toFixed(2), { symbol: '$ ', separator: ',', decimal: '.', precision: 2 }).format();

const tableOptions = {
    leftPad: 2,
    style: {
        head: ['bold', 'cyan'],
        border: ['green'],
        compact: true
    },
    columns: [
        // Only include the specified fields
        { field: "size", name: chalk.yellow("Size") }, // Size
        { field: "notionalSize", name: chalk.green("Notional Size") }, // Notional Size
        { field: "exposedAmount", name: chalk.green("Exposed Amount") },
        { field: "leverage", name: chalk.green("leverage") }, // Notional Size
        { field: "entryPrice", name: chalk.blue("Entry Price") }, // Entry Price
        { field: "breakEvenPrice", name: chalk.cyan("Break Even Price") }, // Break Even Price
        { field: "markPrice", name: chalk.green("Mark Price") }, // Mark Price
        { field: "liqPrice", name: chalk.magenta("Liq. Price") }, // Liquidation Price
        { field: "marginRatio", name: chalk.yellow("Margin Ratio") }, // Margin Ratio
        { field: "margin", name: chalk.green("Margin") }, // Margin (Exposed Amount)
        { field: "rawPnl", name: chalk.green("PNL") }, // PNL as ROI
        { field: "pnlROI", name: chalk.green("PNL ROI %") }, // PNL as ROI
        { field: "tpSlInfo", name: chalk.blue("TP/SL") }, // TP/SL for entire position
        { field: "balanceChange", name: chalk.blue("Balance Effect") }, // TP/SL for entire position,
        { field: "fees", name: chalk.blue("Fee Costs") }, // TP/SL for entire position

    ],
};

// Initialize aggregates for longs and shorts
// Long and short trade tracking
let totalLongs = 0;
let totalShorts = 0;
let totalLongsPnl = math.bignumber(0);
let totalShortsPnl = math.bignumber(0);
let totalLongsSize = math.bignumber(0);
let totalShortsSize = math.bignumber(0);
let totalLongsFees = math.bignumber(0);
let totalShortsFees = math.bignumber(0);
let totalLongsNotionalSize = math.bignumber(0);
let totalShortsNotionalSize = math.bignumber(0);
let totalLongsMargin = math.bignumber(0);
let totalShortsMargin = math.bignumber(0);
let totalLongsMarginRatio = math.bignumber(0);
let totalShortsMarginRatio = math.bignumber(0);
let totalLongsPnlROI = math.bignumber(0);
let totalShortsPnlROI = math.bignumber(0);

// Total PnL and Fees
let totalPnL = math.bignumber(0);
let totalFeesCombined = math.bignumber(0);

const simulateTradesWithRiskManagement = async (startingCapital, winrate, targetCapital, leverage) => {
    // Input validation
    if (!startingCapital || startingCapital <= 0) {
        console.log(chalk.red("Liquidation occurred: Capital is depleted."));
        throw new Error('Invalid starting capital');
    }
    if (!winrate || winrate <= 0 || winrate > 1) {
        throw new Error('Invalid winrate. Winrate must be between 0 and 1.');
    }
    if (!targetCapital || targetCapital <= 0) {
        throw new Error('Invalid target capital. Target capital must be greater than 0.');
    }
    if (!leverage || leverage <= 0) {
        throw new Error('Invalid leverage. Leverage must be greater than 0.');
    }

    // Convert all initial inputs to BigNumber
    const capitalBN = math.bignumber(startingCapital);
    const targetCapitalBN = math.bignumber(targetCapital);
    const leverageBN = math.bignumber(leverage);
    const winrateBN = math.bignumber(winrate);

    // Initialize core variables with BigNumber precision
    let capital = capitalBN;
    let previousCapital = capitalBN;
    let trades = [];
    let consecutiveWins = math.bignumber(0);
    let consecutiveLosses = math.bignumber(0);

    // Enhanced risk management parameters
    const maxDrawdown = math.bignumber(0.20); // 10% max drawdown (more conservative)
    const basePositionSize = math.bignumber(0.30); // Base position size (2% of capital)
    const maxPositionSize = math.bignumber(0.30); // Max position size (5% of capital)
    const minPositionSize = math.bignumber(0.01); // Min position size (1% of capital)
    // const minNotional = math.bignumber(10); // Minimum notional size of $10

    // Fee structure (entry and exit fees)
    const entryFee = math.bignumber(0.001); // 0.1% entry fee
    const exitFee = math.bignumber(0.001); // 0.1% exit fee

    // Performance tracking variables
    let highWaterMark = capital;
    let totalFees = math.bignumber(0);
    let totalTrades = 0;
    let profitableTrades = 0;
    let trendStrength = math.bignumber(0); // Trend strength for win rate adjustment

    const calculatePositionSize = () => {
        let positionSize = math.bignumber(basePositionSize); // Start with the base position size

        // Martingale logic: Double the position size after each loss
        if (math.larger(consecutiveLosses, 0)) {
            positionSize = math.multiply(positionSize, math.pow(2, math.number(consecutiveLosses)));
        }

        // Reset position size to base after a win
        if (math.larger(consecutiveWins, 0)) {
            positionSize = math.bignumber(basePositionSize);
        }

        // Adjust position size based on drawdown
        const currentDrawdown = math.subtract(1, math.divide(capital, highWaterMark));
        if (math.larger(currentDrawdown, 0.05)) {
            positionSize = math.multiply(positionSize, math.bignumber(0.75)); // Reduce size if drawdown > 5%
        }

        // Enforce position size limits (min/max)
        return math.max(math.min(positionSize, maxPositionSize), minPositionSize);
    };

    // Execute a single trade
    const executeTrade = () => {
        totalTrades++;
        previousCapital = capital;

        // Determine trade direction randomly (long or short)
        const goLong = Math.random() < 0.5;
        const tradeDirection = goLong ? "LONG" : "SHORT";

        // Set markPrice and calculate TP and SL based on the trade direction
        const desiredWinPnL = 0.40; // 30% profit on capital
        const desiredLossPnL = 0.10; // 10% loss on capital
        const markPrice = 3; // Example current price
        const entryPrice = 3; // Price at which the trade was entered

        // Calculate TP and SL based on the desired PnL and leverage
        let tpPrice, slPrice;
        if (goLong) {
            tpPrice = entryPrice * (1 + (desiredWinPnL / leverage)); // TP for long (30% win)
            slPrice = entryPrice * (1 - (desiredLossPnL / leverage)); // SL for long (10% loss)
        } else {
            tpPrice = entryPrice * (1 - (desiredWinPnL / leverage)); // TP for short (30% win)
            slPrice = entryPrice * (1 + (desiredLossPnL / leverage)); // SL for short (10% loss)
        }

        // Calculate position size based on the current mode
        let positionSize = calculatePositionSize();

        // Calculate exposure and fees
        let exposedAmount = math.multiply(capital, positionSize);
        let notionalSize = math.multiply(capital, math.multiply(positionSize, leverage));
        let leveragedAmount = math.multiply(exposedAmount, leverageBN); // Leveraged exposure

        // Ensure notionalSize meets the minimum notional
        if (math.smaller(notionalSize, minNotional)) {
            positionSize = math.divide(minNotional, math.multiply(capital, markPrice)); // Adjust position size
            exposedAmount = math.multiply(capital, positionSize);
            notionalSize = math.multiply(exposedAmount, markPrice); // Recalculate notional size
            leveragedAmount = math.multiply(exposedAmount, leverageBN); // Recalculate leveraged amount
        }

        // Simulate trade outcome based on win rate
        const isWin = Math.random() < math.number(winrateBN);

        // Calculate profit/loss and adjust based on win/loss and leverage
        let profitLoss;
        if (isWin) {
            profitLoss = math.multiply(math.bignumber(desiredWinPnL), math.divide(leveragedAmount, leverageBN))            
            consecutiveWins = math.add(consecutiveWins, 1);
            consecutiveLosses = math.bignumber(0);
            profitableTrades++;
            trendStrength = math.min(math.add(trendStrength, 1), math.bignumber(5)); // Increase trend strength on win
        } else {
            profitLoss = math.multiply(math.bignumber(-desiredLossPnL), math.divide(leveragedAmount, leverageBN));            
            consecutiveLosses = math.add(consecutiveLosses, 1);
            consecutiveWins = math.bignumber(0);
            trendStrength = math.max(math.subtract(trendStrength, 1), math.bignumber(-5)); // Decrease trend strength on loss
        }

        // Apply fees (entry + exit)
        const entryFeeAmount = math.multiply(exposedAmount, entryFee);
        const exitFeeAmount = math.multiply(math.abs(profitLoss), exitFee);
        totalFees = math.add(totalFees, math.add(entryFeeAmount, exitFeeAmount));

        // Update capital after trade result and fees
        capital = math.subtract(math.add(capital, profitLoss), math.add(entryFeeAmount, exitFeeAmount));

        // Update high water mark (track the highest capital reached)
        if (math.larger(capital, highWaterMark)) {
            highWaterMark = capital;
        }

        // Update long/short trade tracking
        if (goLong) {
            totalLongs++;
            totalLongsPnl = math.add(totalLongsPnl, profitLoss);
            totalLongsSize = math.add(totalLongsSize, positionSize);
            totalLongsFees = math.add(totalLongsFees, math.add(entryFeeAmount, exitFeeAmount));
            totalLongsNotionalSize = math.add(totalLongsNotionalSize, leveragedAmount);
            totalLongsMargin = math.add(totalLongsMargin, exposedAmount);
            totalLongsMarginRatio = math.add(totalLongsMarginRatio, math.divide(exposedAmount, capital));
            totalLongsPnlROI = math.add(totalLongsPnlROI, math.divide(profitLoss, exposedAmount));
        } else {
            totalShorts++;
            totalShortsPnl = math.add(totalShortsPnl, profitLoss);
            totalShortsSize = math.add(totalShortsSize, positionSize);
            totalShortsFees = math.add(totalShortsFees, math.add(entryFeeAmount, exitFeeAmount));
            totalShortsNotionalSize = math.add(totalShortsNotionalSize, leveragedAmount);
            totalShortsMargin = math.add(totalShortsMargin, exposedAmount);
            totalShortsMarginRatio = math.add(totalShortsMarginRatio, math.divide(exposedAmount, capital));
            totalShortsPnlROI = math.add(totalShortsPnlROI, math.divide(profitLoss, exposedAmount));
        }

        // Update total PnL and fees
        totalPnL = math.add(totalPnL, profitLoss);
        totalFeesCombined = math.add(totalFeesCombined, math.add(entryFeeAmount, exitFeeAmount));

        // Log trade details
        trades.push({
            index: totalTrades,
            side: tradeDirection.toLowerCase(),
            symbol: "DEGOUSDT", // Example symbol
            leverage: `x${leverage}`,
            balance: `$ ${math.number(previousCapital).toFixed(2)} → $ ${math.number(capital).toFixed(2)}`,
            balanceChange: `$ ${math.number(previousCapital).toFixed(2)} → $ ${math.number(capital).toFixed(2)} (${math.larger(capital, previousCapital) ? '+' : ''}${(math.number(math.subtract(capital, previousCapital)) / math.number(previousCapital) * 100).toFixed(2)}%)`,
            fees: `$ ${math.number(math.add(entryFeeAmount, exitFeeAmount)).toFixed(3)}`,
            entryFee: math.number(entryFeeAmount),
            exitFee: math.number(exitFeeAmount),
            rawPnl: math.number(profitLoss).toFixed(4),
            tradeSize: math.number(positionSize),
            size: `${math.round(notionalSize / markPrice) > 0 ? math.round(notionalSize / markPrice) : 1} contracts`, // Use notionalSize for contract size
            notionalSize: `${math.number(notionalSize).toFixed(3)}`, // Use notionalSize here
            margin: math.number(exposedAmount).toFixed(3),
            marginRatio: math.number(math.multiply(math.divide(exposedAmount, capital), 100)).toFixed(3),
            pnlROI: math.number(math.multiply(math.divide(profitLoss, exposedAmount), 100)).toFixed(4),
            entryPrice: math.number(entryPrice),
            breakEvenPrice: math.number(entryPrice), // Simplified break-even price
            markPrice: math.number(markPrice),
            liqPrice: math.number(markPrice * (1 - (1 / leverage))).toFixed(4), // Simplified liquidation price
            tpSlInfo: `TP: $ ${math.number(tpPrice).toFixed(2)}, SL: $ ${math.number(slPrice).toFixed(2)}`,
            exposedAmount: `$ ${math.number(exposedAmount).toFixed(2)} (${(math.number(positionSize) * 100).toFixed(2)}% balance $ ${math.number(previousCapital).toFixed(2)})`,
        });

        // Check for excessive drawdown (stop if max drawdown exceeded)
        const drawdown = math.subtract(1, math.divide(capital, highWaterMark));
        if (math.larger(drawdown, maxDrawdown) || math.smaller(capital, 0)) {
            console.log(chalk.red("\nMax drawdown exceeded or allocated capital depleted. Stopping simulation."));
            console.log(chalk.gray(`Current Capital: `) + chalk.red(currencyFormatterUSD(math.number(capital))));
            console.log(chalk.gray(`High Water Mark: `) + chalk.green(currencyFormatterUSD(math.number(highWaterMark))));
            console.log(chalk.gray(`Drawdown: `) + chalk.red(`${math.number(math.multiply(drawdown, 100)).toFixed(2)}%`));
            console.log(chalk.gray(`Max Drawdown Allowed: `) + chalk.red(`${math.number(math.multiply(maxDrawdown, 100)).toFixed(2)}%\n`));
            return false;
        }

        return math.smaller(capital, targetCapitalBN);
    };

    // Main trading loop
    const runTradingLoop = async () => {
        while (true) {
            const tradeSuccessful = await executeTrade();

            // Break conditions
            if (totalTrades >= 1000) {
                console.log('Maximum number of trades reached. Stopping the trading loop.');
                break;
            }
            if (!tradeSuccessful) {
                console.log('Trade unsuccessful. Stopping the trading loop.');
                break;
            }
            if (math.larger(capital, targetCapitalBN)) {
                console.log(`Target capital of ${math.number(targetCapitalBN)} reached. Stopping the trading loop.`);
                break;
            }
        }
    };

    // Start the trading loop and wait for it to finish
    try {
        await runTradingLoop();
    } catch (error) {
        console.error('Error in trading loop:', error);
        throw error;
    }

    // Calculate final statistics
    const finalStats = {
        totalTrades,
        trades,
        profitableTrades,
        table: chalkTable(tableOptions, trades),
        winRate: math.number(math.multiply(math.divide(math.bignumber(profitableTrades), math.bignumber(totalTrades)), 100)),
        finalCapital: math.number(capital),
        totalFees: math.number(totalFees),
        returnOnInvestment: math.number(math.multiply(math.subtract(math.divide(capital, capitalBN), 1), 100)),
        maxDrawdown: math.number(math.multiply(math.subtract(1, math.divide(math.bignumber(math.min(...trades.map(t => parseFloat(t.balance.replace(/[^0-9.-]+/g, ""))))), highWaterMark)), 100))
    };

    return finalStats;
};




let savings = math.bignumber(0);
let savingsRate = 0.2; // Save 20% of profits at the end of each stage


async function runSimulationInStages(startingCapital, targetGoal, winrate, leverage) {
    let currentCapital = math.bignumber(startingCapital);
    let overallTarget = math.bignumber(targetGoal);
    let stageTargetMultiplier = math.bignumber(15.75);
    let stageCount = 1;
    let stageRetryCount = 0; // Counter to track retries for the current stage


    while (math.smaller(currentCapital, overallTarget)) {
        console.log(chalk.cyan(`\n=== Stage ${stageCount} (Attempt ${stageRetryCount + 1}) ===`));
        console.log(chalk.yellow(`Starting capital: ${currencyFormatterUSD(math.number(currentCapital))}`));
        console.log(chalk.yellow(`Savings: ${currencyFormatterUSD(math.number(savings))}`));

        // Calculate next target
        const nextTarget = math.min(
            math.add(currentCapital, math.multiply(currentCapital, stageTargetMultiplier)),
            overallTarget
        );

        console.log(chalk.yellow(`Target for this stage: ${currencyFormatterUSD(math.number(nextTarget))}`));

        // Simulate trades for this stage
        const result = await simulateTradesWithRiskManagement(
            math.number(currentCapital),
            winrate,
            math.number(nextTarget),
            leverage
        );

        console.log(result.table)

        // Process results and update capital/savings
        const stageProfit = math.subtract(math.bignumber(result.finalCapital), currentCapital);
        if (math.larger(stageProfit, 0)) {
            const savingsAmount = math.multiply(stageProfit, savingsRate);
            savings = math.add(savings, savingsAmount);
            currentCapital = math.subtract(math.bignumber(result.finalCapital), savingsAmount);
            console.log(chalk.green(`Saved ${currencyFormatterUSD(math.number(savingsAmount))} to savings.`));
        } else {
            currentCapital = math.bignumber(result.finalCapital);
        }

        console.log(chalk.yellow(`Updated Capital: ${currencyFormatterUSD(math.number(currentCapital))}`));
        console.log(chalk.yellow(`Total Savings: ${currencyFormatterUSD(math.number(savings))}`));

        // Check if the stage goal is achieved
        if (math.largerEq(math.bignumber(result.finalCapital), nextTarget)) {
            console.log(chalk.green(`Stage ${stageCount} goal achieved!`));
            stageCount++; // Increment stage count only if the goal is achieved
            stageRetryCount = 0
        } else {
            console.log(chalk.red(`Stage ${stageCount} goal not achieved. Retrying stage.`));
            stageRetryCount++;
        }

        // Check if maximum stages reached
        if (stageCount > 10000) {
            console.log(chalk.red('\nMaximum number of stages reached. Stopping simulation.'));
            break;
        }

        // Check if overall target achieved
        if (math.largerEq(math.add(currentCapital, savings), overallTarget)) {
            console.log(chalk.green('\nCongratulations! Overall target achieved.'));
            break;
        }
    }

    // Log final results
    console.log(chalk.green(`\nSimulation complete!`));
    console.log(chalk.gray(`Final Trading Capital: `) + chalk.green(currencyFormatterUSD(math.number(currentCapital))));
    console.log(chalk.gray(`Total Savings: `) + chalk.green(currencyFormatterUSD(math.number(savings))));
    console.log(chalk.gray(`Overall Net Worth: `) + chalk.green(currencyFormatterUSD(math.add(currentCapital, savings))));

    console.log(chalk.cyan('\nCombined Results for Longs and Shorts:'));
    console.log(chalk.gray(`Total Long Trades: `) + chalk.green(totalLongs));
    console.log(chalk.gray(`Total Short Trades: `) + chalk.green(totalShorts));
    console.log(chalk.gray(`Total Long PnL: `) + chalk.green(currencyFormatterUSD(math.number(totalLongsPnl))));
    console.log(chalk.gray(`Total Short PnL: `) + chalk.green(currencyFormatterUSD(math.number(totalShortsPnl))));
    console.log(chalk.gray(`Total Long Size: `) + chalk.green(`${math.number(math.multiply(totalLongsSize, 100)).toFixed(2)}%`));
    console.log(chalk.gray(`Total Short Size: `) + chalk.green(`${math.number(math.multiply(totalShortsSize, 100)).toFixed(2)}%`));
    console.log(chalk.gray(`Total Long Fees: `) + chalk.green(currencyFormatterUSD(math.number(totalLongsFees))));
    console.log(chalk.gray(`Total Short Fees: `) + chalk.green(currencyFormatterUSD(math.number(totalShortsFees))));
    console.log(chalk.gray(`Total Long Notional Size: `) + chalk.green(currencyFormatterUSD(math.number(totalLongsNotionalSize))));
    console.log(chalk.gray(`Total Short Notional Size: `) + chalk.green(currencyFormatterUSD(math.number(totalShortsNotionalSize))));
    console.log(chalk.gray(`Total Long Margin: `) + chalk.green(currencyFormatterUSD(math.number(totalLongsMargin))));
    console.log(chalk.gray(`Total Short Margin: `) + chalk.green(currencyFormatterUSD(math.number(totalShortsMargin))));
    console.log(chalk.gray(`Total Long Margin Ratio: `) + chalk.green(`${math.number(math.multiply(totalLongsMarginRatio, 100)).toFixed(2)}%`));
    console.log(chalk.gray(`Total Short Margin Ratio: `) + chalk.green(`${math.number(math.multiply(totalShortsMarginRatio, 100)).toFixed(2)}%`));
    console.log(chalk.gray(`Total Long PnL ROI: `) + chalk.green(`${math.number(math.multiply(totalLongsPnlROI, 100)).toFixed(2)}%`));
    console.log(chalk.gray(`Total Short PnL ROI: `) + chalk.green(`${math.number(math.multiply(totalShortsPnlROI, 100)).toFixed(2)}%`));
    // Example for losses in red:
    if (totalLongsPnl < 0) {
        console.log(chalk.red(`Loss in Long PnL: `) + chalk.green(currencyFormatterUSD(totalLongsPnl)));
    }
    if (totalShortsPnl < 0) {
        console.log(chalk.red(`Loss in Short PnL: `) + chalk.green(currencyFormatterUSD(totalShortsPnl)));
    }
}

// Example usage
const innitialStartingCapital = 0.49; // Initial capital in USDT
const targetGoal = math.bignumber(5.03); // Final goal in USDT

runSimulationInStages(innitialStartingCapital, targetGoal, winrate, leverage);
