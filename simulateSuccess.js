const Binance = require('node-binance-api');
const currency = require('currency.js');
const math = require('mathjs');
const moment = require('moment');
const chalk = require('chalk');
const chalkTable = require('chalk-table');
require('dotenv').config();

// Enhanced Constants
const INITIAL_POSITION_SIZE = math.bignumber(0.02);    // Start with 2% position size
const MAX_POSITION_SIZE = math.bignumber(0.30);        // Cap at 30% position size
const MIN_NOTIONAL = math.bignumber(5.1);              // Minimum trade size
const BASE_LEVERAGE = 75;                              // Base leverage
const MAX_RETRY_MULTIPLIER = 2;                        // Maximum position multiplier for retries
const SAVINGS_RATE = math.bignumber(0.50);             // Save 50% of profits
const MAX_DRAWDOWN = 2.00;                             // 200% max drawdown
const STAGE_GROWTH_MULTIPLIER = 15;                    // More conservative stage targets

// Trading pair setup
let symbol = "DEGOUSDT";
let markPrice = math.bignumber(3); // Example fixed price for simulation

// Formatting helpers
const currencyFormatterUSD = (amount = 0) => currency(amount.toFixed(2), {
    symbol: '$ ',
    separator: ',',
    decimal: '.',
    precision: 2
}).format();

// Enhanced table options for better visualization
const tableOptions = {
    leftPad: 2,
    style: {
        head: ['bold', 'cyan'],
        border: ['green'],
        compact: true
    },
    columns: [
        { field: "stage", name: chalk.yellow("Stage") },
        { field: "attempt", name: chalk.yellow("Attempt") },
        { field: "size", name: chalk.yellow("Size") },
        { field: "notionalSize", name: chalk.green("Notional Size") },
        { field: "positionSize", name: chalk.green("Position") },
        { field: "positionSizePercent", name: chalk.green("Position %") },
        { field: "exposedAmount", name: chalk.green("Exposed $") },
        { field: "effectiveLeverage", name: chalk.blue("Leverage") },
        { field: "entryPrice", name: chalk.blue("Entry") },
        { field: "markPrice", name: chalk.green("Mark") },
        { field: "liqPrice", name: chalk.magenta("Liq.") },
        { field: "drawdown", name: chalk.red("Drawdown %") },
        { field: "pnl", name: chalk.green("PnL") },
        { field: "pnlPercent", name: chalk.green("PnL %") },
        { field: "balance", name: chalk.blue("Balance") },
        { field: "savings", name: chalk.cyan("Savings") }
    ]
};

const calculatePositionSize = (state, mode = "martingale") => {
    const { capital, consecutiveLosses, previousPositionSize, consecutiveWins } = state;

    // Base position size
    let positionSize = previousPositionSize || INITIAL_POSITION_SIZE;

    switch (mode) {
        case "martingale":
            if (math.larger(consecutiveLosses, 0)) {
                const retryMultiplier = math.add(math.number(consecutiveLosses), 1);
                positionSize = math.multiply(INITIAL_POSITION_SIZE, retryMultiplier);
            }
            break;

        case "antiMartingale":
            if (math.larger(consecutiveWins, 0)) {
                const growthMultiplier = math.min(
                    1 + (math.number(consecutiveWins) * 0.5),
                    MAX_RETRY_MULTIPLIER
                );
                positionSize = math.multiply(positionSize, growthMultiplier);
            } else {
                positionSize = INITIAL_POSITION_SIZE;
            }
            break;

        case "customMartingale":
            if (math.larger(consecutiveLosses, 0)) {
                const retryMultiplier = math.min(
                    1 + (math.number(consecutiveLosses) * 0.5),
                    MAX_RETRY_MULTIPLIER
                );
                positionSize = math.multiply(positionSize, retryMultiplier);

                state.effectiveLeverage = math.min(
                    BASE_LEVERAGE + (math.number(consecutiveLosses) * 5),
                    MAX_RETRY_MULTIPLIER * BASE_LEVERAGE
                );
            }
            break;

        default:
            throw new Error("Invalid trading mode");
    }

    // Ensure position size does not exceed the maximum allowed
    positionSize = math.min(positionSize, MAX_POSITION_SIZE);

    // Calculate notional size (total value of the position)
    let notionalSize = math.multiply(math.multiply(capital, positionSize), markPrice);

    // Apply leverage to the notional size
    let leveragedNotionalSize = math.multiply(notionalSize, BASE_LEVERAGE);

    // Adjust position size if leveraged notional size is below the minimum notional requirement
    if (math.smaller(leveragedNotionalSize, MIN_NOTIONAL)) {
        // Recalculate position size to meet the minimum notional requirement
        positionSize = math.divide(MIN_NOTIONAL, math.multiply(math.multiply(capital, markPrice), BASE_LEVERAGE));

        // Recalculate notional size and leveraged notional size with the updated position size
        notionalSize = math.multiply(math.multiply(capital, positionSize), markPrice);
        leveragedNotionalSize = math.multiply(notionalSize, BASE_LEVERAGE);
    }

    // Ensure position size does not exceed available capital
    if (math.larger(math.multiply(capital, positionSize), capital)) {
        // Recalculate position size to fit available capital
        positionSize = math.divide(capital, math.multiply(capital, markPrice));

        // Recalculate notional size and leveraged notional size with the updated position size
        notionalSize = math.multiply(math.multiply(capital, positionSize), markPrice);
        leveragedNotionalSize = math.multiply(notionalSize, BASE_LEVERAGE);
    }

    return {
        positionSize,
        notionalSize: leveragedNotionalSize
    };
};

const STOP_LOSS_PERCENT = 0.01; // 1% stop-loss
const TAKE_PROFIT_PERCENT = 0.01; // 1% take-profit

const executeTrade = (state, mode = "martingale") => {
    const { positionSize, notionalSize } = calculatePositionSize(state, mode);
    const exposedAmount = math.multiply(state.capital, positionSize);

    let effectiveLeverage = BASE_LEVERAGE;
    if (mode === "customMartingale") {
        effectiveLeverage = state.effectiveLeverage || BASE_LEVERAGE;
    }

    // Calculate TP and SL prices
    const entryPrice = math.number(markPrice);
    const tpPrice = entryPrice * (1 + TAKE_PROFIT_PERCENT);
    const slPrice = entryPrice * (1 - STOP_LOSS_PERCENT);

    // Simulate price movement (randomly decide if it hits TP or SL)
    const isWin = Math.random() < 0.5;
    const exitPrice = isWin ? tpPrice : slPrice;

    // Calculate PnL based on exit price
    const priceChange = (exitPrice - entryPrice) / entryPrice;
    const profitLoss = math.multiply(notionalSize, math.bignumber(priceChange));

    // Deduct fees
    const fees = math.multiply(exposedAmount, 0.002);
    const newCapital = math.subtract(math.add(state.capital, profitLoss), fees);
    const isCapitalDepleted = math.smallerEq(newCapital, 0);

    // Update consecutive wins/losses
    if (isWin) {
        state.consecutiveWins = math.add(state.consecutiveWins || math.bignumber(0), math.bignumber(1));
        state.consecutiveLosses = math.bignumber(0);
    } else {
        state.consecutiveLosses = math.add(state.consecutiveLosses || math.bignumber(0), math.bignumber(1));
        state.consecutiveWins = math.bignumber(0);
    }

    // Martingale adjustment: Double the position size after a loss
    if (mode === "martingale" && !isWin) {
        state.positionSize = math.multiply(state.positionSize || math.bignumber(0.01), math.bignumber(2));
    }

    // Update high water mark
    if (math.larger(state.capital, state.highWaterMark)) {
        state.highWaterMark = state.capital;
    }

    // Calculate drawdown
    const drawdown = math.multiply(
        math.subtract(1, math.divide(state.capital, state.highWaterMark)),
        100
    );

    // Calculate initial margin (position size in terms of capital)
    const initialMargin = math.divide(notionalSize, effectiveLeverage);

    // Calculate PnL percentage based on initial margin
    const pnlPercent = math.multiply(
        math.divide(profitLoss, initialMargin),
        100
    );

    const liqPrice = math.multiply(
        entryPrice,
        math.subtract(1, math.divide(1, effectiveLeverage))
    );

    // Create the trade object
    const trade = {
        stage: math.number(state.stageCount),
        attempt: math.number(state.stageRetryCount) + 1,
        size: `${math.round(math.divide(notionalSize, markPrice))} contracts`,
        notionalSize: currencyFormatterUSD(math.number(notionalSize)),
        positionSize: currencyFormatterUSD(math.number(initialMargin)), // Use initial margin as position size
        positionSizePercent: `${(math.number(positionSize) * 100).toFixed(2)}%`,
        exposedAmount: currencyFormatterUSD(math.number(exposedAmount)),
        effectiveLeverage: `${math.round(effectiveLeverage)}x`,
        entryPrice: entryPrice,
        markPrice: exitPrice.toFixed(4), // Use exit price as mark price
        liqPrice,
        drawdown: math.max(0, math.number(drawdown)).toFixed(2), // Ensure drawdown is not negative
        pnl: currencyFormatterUSD(math.number(profitLoss)),
        pnlPercent: `${math.number(pnlPercent).toFixed(2)}%`, // Corrected PnL percentage
        balance: currencyFormatterUSD(math.number(newCapital)),
        savings: currencyFormatterUSD(math.number(state.savings))
    };

    // Update state
    state.capital = newCapital;
    state.stageCount = math.add(state.stageCount || math.bignumber(0), math.bignumber(1));
    if (!isWin) {
        state.stageRetryCount = math.add(state.stageRetryCount || math.bignumber(0), math.bignumber(1));
    } else {
        state.stageRetryCount = math.bignumber(0);
    }

    return { trade, state, isCapitalDepleted };
};

// Enhanced multi-stage trading
const runMultiStageTrading = async (startingCapital, targetCapital) => {
    let state = {
        capital: math.bignumber(startingCapital),
        consecutiveLosses: math.bignumber(0),
        consecutiveWins: math.bignumber(0),
        previousPositionSize: null,
        stageCount: math.bignumber(1),
        stageRetryCount: math.bignumber(0),
        attempts: [], // Tracks all attempts within the current stage
        stageStartCapital: math.bignumber(startingCapital),
        highWaterMark: math.bignumber(startingCapital),
        savings: math.bignumber(0),
        drawdown: math.bignumber(0),
        isLiquidated: false
    };

    const maxStages = math.bignumber(10000);
    const maxRetries = math.bignumber(20);

    // Dynamic stage growth multiplier
    const STAGE_GROWTH_MULTIPLIER_DYNAMIC = math.divide(targetCapital, startingCapital);

    // Array to store all stages and their attempts for logging
    const simulationLogs = [];

    while (math.smaller(math.add(state.capital, state.savings), targetCapital) && math.smallerEq(state.stageCount, maxStages)) {
        console.log(chalk.cyan(`\n=== Stage ${math.number(state.stageCount)} ===`));
        console.log(chalk.yellow(`Starting capital: ${currencyFormatterUSD(math.number(state.capital))}`));
        console.log(chalk.yellow(`Savings: ${currencyFormatterUSD(math.number(state.savings))}`));
        console.log(chalk.yellow(`Total: ${currencyFormatterUSD(math.number(math.add(state.capital, state.savings)))}`));

        // Calculate stage target
        const stageTarget = math.multiply(state.stageStartCapital, STAGE_GROWTH_MULTIPLIER_DYNAMIC);
        console.log(chalk.yellow(`Target for this stage: ${currencyFormatterUSD(math.number(stageTarget))}`));

        // Reset attempts for the current stage
        state.attempts = [];

        // Execute multiple attempts within the stage
        while (math.smaller(state.capital, stageTarget) && math.smallerEq(state.stageRetryCount, maxRetries)) {
            console.log(chalk.cyan(`\n--- Attempt ${math.number(state.stageRetryCount) + 1} ---`));

            // Reset trades for the current attempt
            const currentAttempt = {
                attemptNumber: math.number(state.stageRetryCount) + 1,
                trades: [], // Initialize as an empty array
                savings: 0
            };

            // Execute multiple trades within the attempt
            while (math.smaller(state.capital, stageTarget) && !state.isLiquidated) {
                // Execute trade and preserve all state properties
                const { trade, state: tradeResult } = executeTrade(state);
                state = {
                    ...state,
                    capital: tradeResult.capital,
                    consecutiveLosses: tradeResult.consecutiveLosses,
                    consecutiveWins: tradeResult.consecutiveWins,
                    previousPositionSize: tradeResult.previousPositionSize,
                    highWaterMark: tradeResult.highWaterMark,
                    drawdown: tradeResult.drawdown,
                    isLiquidated: tradeResult.isLiquidated
                };

                // Add the trade to the current attempt's trades array
                currentAttempt.trades.push(trade);

                // Check if capital is depleted
                if (math.smallerEq(state.capital, 0)) {
                    console.log(chalk.red("\nCapital depleted. Simulation stopped."));
                    state.isLiquidated = true;
                    break;
                }
            }

            // Add the current attempt to the stage's attempts
            state.attempts.push(currentAttempt);

            // Check for stage completion or failure
            if (state.isLiquidated || math.smallerEq(state.capital, 0)) {
                // Log the trades for the failed attempt
                console.log(chalk.cyan(`\nTrades for Attempt ${math.number(state.stageRetryCount)}:`));
                console.log(chalkTable(tableOptions, currentAttempt.trades));

                console.log(chalk.red("\nStage failed:"));
                console.log(chalk.gray(`Drawdown: ${math.number(state.drawdown).toFixed(2)}%`));
                console.log(chalk.gray(`Max Allowed: ${MAX_DRAWDOWN * 100}%`));
                console.log(chalk.gray(`Attempt: ${math.number(state.stageRetryCount) + 1}/${math.number(maxRetries)}`));

                // Log the reason for retry
                if (math.larger(state.drawdown, MAX_DRAWDOWN * 100)) {
                    console.log(chalk.red("Reason: Drawdown exceeded maximum allowed."));
                } else if (math.smallerEq(state.capital, 0)) {
                    console.log(chalk.red("Reason: Capital depleted."));
                } else {
                    console.log(chalk.red("Reason: Trade resulted in a loss."));
                }

                // Increment retry count on every loop iteration within the same stage
                state = {
                    ...state,
                    stageRetryCount: math.add(state.stageRetryCount, math.bignumber(1)),
                    capital: state.stageStartCapital,
                    consecutiveLosses: math.bignumber(0),
                    consecutiveWins: math.bignumber(0),
                    previousPositionSize: math.multiply(
                        state.previousPositionSize || INITIAL_POSITION_SIZE,
                        math.bignumber(0.50)
                    ),
                    isLiquidated: false // Reset liquidation flag for the next attempt
                };

                // If max retries reached, move to the next stage
                if (math.largerEq(state.stageRetryCount, maxRetries)) {
                    console.log(chalk.red(`\nMax retries reached for stage ${math.number(state.stageCount)}. Moving to next stage.`));
                    state = {
                        ...state,
                        stageCount: math.add(state.stageCount, math.bignumber(1)),
                        stageRetryCount: math.bignumber(0),
                        stageStartCapital: state.capital
                    };
                    break; // Exit the attempts loop and move to the next stage
                }
            } else if (math.larger(state.capital, stageTarget)) {
                // Calculate profits and savings
                const profits = math.subtract(state.capital, state.stageStartCapital);
                const savingsAmount = math.multiply(profits, SAVINGS_RATE);

                // Update state with new savings and capital
                state.savings = math.add(state.savings, savingsAmount);
                state.capital = math.subtract(state.capital, savingsAmount);

                // Log the trades for the current attempt
                console.log(chalk.cyan(`\nTrades for Attempt ${math.number(state.stageRetryCount)}:`));
                console.log(chalkTable(tableOptions, currentAttempt.trades));

                console.log(chalk.green(`\nStage ${math.number(state.stageCount)} completed successfully!`));
                console.log(chalk.gray("Stage Profit: ") + chalk.green(currencyFormatterUSD(math.number(profits))));
                console.log(chalk.gray("Savings Added: ") + chalk.green(currencyFormatterUSD(math.number(savingsAmount))));

                // Update state with new savings and capital
                const newCapital = math.subtract(state.capital, savingsAmount);
                state = {
                    ...state,
                    savings: math.add(state.savings, savingsAmount),
                    capital: newCapital,
                    stageCount: math.add(state.stageCount, math.bignumber(1)),
                    stageRetryCount: math.bignumber(0),
                    stageStartCapital: newCapital,
                    consecutiveLosses: math.bignumber(0),
                    consecutiveWins: math.bignumber(0),
                    previousPositionSize: INITIAL_POSITION_SIZE // Reset position size
                };

                // Update the savings in the last trade log
                if (currentAttempt.trades.length > 0) {
                    const lastTrade = currentAttempt.trades[currentAttempt.trades.length - 1];
                    lastTrade.savings = currencyFormatterUSD(math.number(state.savings));
                } else {
                    console.warn("No trades found in currentAttempt. Cannot update savings.");
                }

                break; // Exit the attempts loop and move to the next stage
            }
        }

        // Add the current stage's attempts to the simulation logs
        simulationLogs.push({
            stage: math.number(state.stageCount),
            startingCapital: currencyFormatterUSD(math.number(state.stageStartCapital)),
            targetCapital: currencyFormatterUSD(math.number(stageTarget)),
            attempts: state.attempts
        });
    }

    // Log the simulation results after the simulation completes
    console.log(chalk.green('\nTrading Simulation Complete'));
    console.log(chalk.gray('Final Capital: ') + chalk.green(currencyFormatterUSD(math.number(state.capital))));
    console.log(chalk.gray('Total Savings: ') + chalk.green(currencyFormatterUSD(math.number(state.savings))));
    console.log(chalk.gray('Net Worth: ') + chalk.green(currencyFormatterUSD(math.number(math.add(state.capital, state.savings)))));

    // Calculate the total number of trades
    const totalTrades = simulationLogs.reduce((total, stageLog) => {
        return total + stageLog.attempts.reduce((stageTotal, attempt) => {
            return stageTotal + attempt.trades.length;
        }, 0);
    }, 0);

    console.log(chalk.gray('Total Trades: ') + chalk.green(totalTrades));
    console.log(chalk.gray('Completed Stages: ') + chalk.green(math.number(math.subtract(state.stageCount, math.bignumber(1)))));

    return state;
};

const startingCapital = 1.00;
const targetCapital = math.bignumber(5.00);

runMultiStageTrading(startingCapital, targetCapital)
// .catch(error => console.error('Simulation error:', error));

module.exports = {
    runMultiStageTrading,
    calculatePositionSize,
    executeTrade
};