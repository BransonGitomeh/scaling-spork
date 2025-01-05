const Binance = require('node-binance-api');
const currency = require('currency.js');
const math = require('mathjs');
const moment = require('moment');
require('moment-duration-format');
const chalk = require('chalk');
const chalkTable = require('chalk-table');
require("dotenv").config();
const fs = require('fs');
const path = require('path');

// Constants
const startingCapital = 1.00; // Initial capital in USDT
const targetCapital = 3.00; // Goal capital in USDT
const winrate = 0.50; // 50% winrate
const leverage = 100; // 100x leverage
const basePrice = 3.00; // Example entry price in USDT
const contractSize = 1.00; // Contract size (e.g., 1 USDT per contract)
const minNotional = math.bignumber(5.1);// Minimum notional required for opening a position
let minMargin = 0.1; // Minimum margin to start with, increases over time
const exchangeRate = 129; // Exchange rate from USDT to KSH
let symbol = "DEGOUSDT";

let { BINANCE_API_KEY, BINANCE_SECRET_KEY } = process.env;
let binance = new Binance().options({
    APIKEY: BINANCE_API_KEY,
    APISECRET: BINANCE_SECRET_KEY,
    family: 4,
    // test: true, // Add this to enable test mode
});


const tradeHistory = []; // Array to store trade history
const sessionDir = './sessions';  // Directory to store session files


// Create the sessions directory if it doesn't exist
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir);
}

// Function to get today's date in YYYY-MM-DD format
const getTodayDate = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// Function to save tradeHistory to a file with today's date
const saveTradeHistory = () => {
    const fileName = `${getTodayDate()}.json`; // Today's date as the filename
    const filePath = path.join(sessionDir, fileName);
    try {
        fs.writeFileSync(filePath, JSON.stringify(tradeHistory, null, 2)); // Save the trade history to file
        console.log(chalk.green(`Trade history saved to ${filePath}`));
    } catch (err) {
        console.error(chalk.red(`Error saving trade history: ${err.message}`));
    }
};

// Function to restore tradeHistory from a file
const restoreTradeHistory = () => {
    const fileName = `${getTodayDate()}.json`; // Today's date as the filename
    const filePath = path.join(sessionDir, fileName);
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            tradeHistory = JSON.parse(data); // Restore the trade history from file
            console.log(chalk.green(`Trade history restored from ${filePath}`));
        } catch (err) {
            console.error(chalk.red(`Error restoring trade history: ${err.message}`));
        }
    }
};

// Function to push a new trade to the tradeHistory array and save it to a file
const pushToTradeHistory = (trade) => {
    tradeHistory.push(trade); // Push the new trade
    saveTradeHistory(); // Save the updated tradeHistory to the file
};

// Restore trade history on startup
restoreTradeHistory();

async function fetchOpenPositions() {
    try {
        // Fetch all positions
        const positions = await binance.futuresPositionRisk();

        // Filter positions to get only those that are open (positionAmt !== 0)
        const openPositions = positions.filter((position) => parseFloat(position.positionAmt) !== 0);

        // Return open positions along with markPrice (optional)
        return openPositions;
    } catch (error) {
        console.error("Error fetching open positions:", error);
        return null; // You can handle errors here as needed
    }
}


async function fetchMarkPrice(symbol) {
    try {
        // Fetch the mark price for the given symbol
        const response = await binance.futuresMarkPrice(symbol);

        // Check if the response contains the mark price
        if (!response.markPrice) {
            throw new Error("Failed to fetch mark price");
        }

        // Parse and return the mark price as a float
        const markPrice = parseFloat(response.markPrice);
        return markPrice;
    } catch (error) {
        console.error("Error fetching mark price:", error);
        throw error; // Rethrow the error or return a fallback value if necessary
    }
}


const currencyFormatterUSD = (amount) => currency(amount?.toFixed(2), { symbol: '$ ', separator: ',', decimal: '.', precision: 2 })?.format();
const currencyFormatterKSH = (amount) => currency(amount?.toFixed(2), { symbol: 'KSh ', separator: ',', decimal: '.', precision: 2 })?.format();

// Update Table Options to include a "Change" column
const tableOptions = {
    leftPad: 2,
    style: {
        head: ['bold', 'cyan'],
        border: ['green'],
        compact: true
    },
    columns: [
        { field: "index", name: chalk.dim("ID") },
        { field: "side", name: chalk.magenta("Side") },
        { field: "symbol", name: chalk.gray("Symbol") },
        { field: "price", name: chalk.blue("Price") },
        { field: "size", name: chalk.yellow("Size") },
        { field: "exposedAmount", name: chalk.green("Exposed Amount") },
        { field: "leverage", name: chalk.blue("Leverage") },
        { field: "pnl", name: chalk.green("P/L") },
        { field: "status", name: chalk.green("Status") },
        { field: "balance", name: chalk.yellow("Balance (USD / KSH)") },
        { field: "fees", name: chalk.yellow("fee") }
    ],
};

async function fetchBalance() {
    try {
        const accountInfo = await binance.futuresBalance();
        // Find the USDT asset in the account balance
        const usdtAsset = accountInfo.find((asset) => asset.asset === "USDT");

        // If no USDT asset is found, log an error
        if (!usdtAsset) {
            console.error(chalk.red(`Error: USDT asset not found in account information`));
            return null; // Return null or a default value as needed
        }

        // Return the balance of USDT
        return usdtAsset.balance; // Assuming balance is the property you need
    } catch (error) {
        console.error('Error fetching Binance balance:', error);
        return null; // Return null or a default value in case of error
    }
}



// Simulate trades with risk management
async function simulateTradesWithRiskManagement(startingCapital, winrate, targetCapital, leverage) {
    let capital = math.bignumber(startingCapital); // Start with the initial capital
    let totalTrades = 0; // Counter for the number of trades

    let currentPositionSize = math.bignumber(startingCapital).times(0.10); // Base position size = 10% of the capital
    let totalExposedAmount = math.bignumber(0); // Total amount exposed in the market
    let consecutiveLosses = 0; // Counter for consecutive losses
    const martingaleMultiplier = 2; // Multiplier to increase position size after a loss
    let previousCapital = math.bignumber(startingCapital); // Track the previous balance
    let liquidated = false; // Flag to check if liquidation occurred

    const feeRate = math.bignumber(0.00018); // 0.01800% fee on entry and exit
    const feeRateExit = math.bignumber(0.00045); // 0.04500% fee on exit

    let totalEntryFee = math.bignumber(0); // To accumulate entry fees
    let totalExitFee = math.bignumber(0); // To accumulate exit fees

    let positionId = null; // Store the ID of the open position (if any)

    // Fetch initial balance
    let initialBalance = await fetchBalance();
    console.log(`Initial Balance: $${initialBalance}`);

    // Check for open positions before starting
    const positions = await fetchOpenPositions();
    if (positions?.length > 0) {
        // Assume that the first position is our current active position
        positionId = positions[0].updateTime ? positions[0].updateTime : null;
    }

    for (let trade = 1; math.smaller(capital, math.bignumber(targetCapital)) && !liquidated; trade++) {
        totalTrades++; // Increment trade count

        // Fetch the current mark price
        const markPrice = await fetchMarkPrice('DEGOUSDT'); // Replace with your symbol
        console.log(`Current Mark Price: $${markPrice}`);

        // Determine if the trade is a win or loss
        const isWin = Math.random() < winrate; // Generate a random number and compare it with the winrate


        // Check if there is an open position
        if (positionId === null) {
            console.log('No open positions. Attempting to open a new trade...');

            try {
                // Adjust position size if below the minimum notional
                if (math.smaller(currentPositionSize.times(markPrice), minNotional)) {
                    currentPositionSize = minNotional.dividedBy(markPrice);
                    console.log(`Adjusted position size to: ${currentPositionSize.toFixed(5).toString()}`);
                }

                // Log details of the trade before execution
                console.log(`Attempting to sell ${currentPositionSize.toFixed(5).toString()} DEGOUSDT at mark price $${markPrice}`);

                // Open a new trade
                const order = await binance.futuresMarketSell('DEGOUSDT', currentPositionSize.toFixed(0).toString());

                // Log the raw order response for debugging
                console.log(`Order response: ${order.id}`);

                // Check for errors in the response
                if (order.code) {
                    console.error(chalk.red(`Error opening position: ${order.msg}`));
                    return; // Exit the function if there's an error
                }

                // Set leverage for the position
                const leverageResponse = await binance.futuresLeverage('DEGOUSDT', leverage);
                console.log(`Leverage set response: ${JSON.stringify(leverageResponse)}`);

                // Store the position ID from the order response
                positionId = order.orderId || null;
                if (positionId) {
                    console.log(`New position opened successfully with ID: ${positionId}`);
                } else {
                    console.error(chalk.red('Error: Position ID not found in order response.'));
                }

                // Calculate entry and exit prices
                const entryPrice = math.bignumber(markPrice);
                const exitPrice = isWin
                    ? math.multiply(entryPrice, 1.10) // 10% gain for wins
                    : math.multiply(entryPrice, 0.95); // 5% loss for losses

                // Calculate profit or loss
                const profitOrLoss = isWin
                    ? math.multiply(currentPositionSize, math.subtract(exitPrice, entryPrice))
                    : math.multiply(currentPositionSize, math.subtract(entryPrice, exitPrice)).neg();


                // Fetch balance after trade execution to decide the result
                const finalBalance = await fetchBalance();

                // Convert finalBalance.totalWalletBalance to a number (or BigNumber)
                const finalBalanceNumber = math.bignumber(finalBalance); // If using math.js, otherwise just use `Number(finalBalance.totalWalletBalance)`

                // Convert initialBalance to BigNumber (or number if you're not using math.js)
                const initialBalanceNumber = math.bignumber(initialBalance); // Use math.bignumber for consistency

                // Calculate the balance change
                const balanceChange = math.subtract(finalBalanceNumber, initialBalanceNumber);

                // Check for liquidation or record trade
                const isLiquidated = math.smaller(capital, 0);
                const tradeSide = isLiquidated ? chalk.red("LIQUIDATED") : winrate ? chalk.magenta("LONG") : chalk.yellow("SHORT");
                const status = isLiquidated ? chalk.red("LIQUIDATED") : winrate ? chalk.green("Profitable") : chalk.red("Loss");
                const pnl = isLiquidated
                    ? chalk.red(`${currencyFormatterUSD(0)} / ${currencyFormatterKSH(0)}`)
                    : winrate
                        ? chalk.green(`${currencyFormatterUSD(math.number(profitOrLoss))} / ${currencyFormatterKSH(math.number(math.multiply(profitOrLoss, exchangeRate)))}`)
                        : chalk.red(`${currencyFormatterUSD(math.number(profitOrLoss))} / ${currencyFormatterKSH(math.number(math.multiply(profitOrLoss, exchangeRate)))}`);
                const balance = isLiquidated
                    ? chalk.red(`${currencyFormatterUSD(math.number(previousCapital))} → $0.00 / KES 0.00`)
                    : chalk.yellow(`${currencyFormatterUSD(math.number(previousCapital))} → ${currencyFormatterUSD(math.number(capital))} = ${currencyFormatterKSH(math.number(capital) * exchangeRate)}`);
                const exposedAmount = isLiquidated
                    ? chalk.red(`${currencyFormatterUSD(math.number(totalExposedAmount))}(${currencyFormatterKSH(math.number(math.multiply(totalExposedAmount, exchangeRate)))})`)
                    : chalk.green(`${currencyFormatterUSD(math.number(totalExposedAmount))} / ${currencyFormatterKSH(math.number(math.multiply(totalExposedAmount, exchangeRate)))}`);

                // Record trade history
                pushToTradeHistory({
                    index: chalk.dim(totalTrades),
                    side: tradeSide,
                    symbol: isLiquidated ? chalk.gray("N/A") : chalk.gray("DEGOUSDT"),
                    price: isLiquidated
                        ? chalk.dim("N/A")
                        : chalk.blue(`${math.number(entryPrice).toFixed(8)} → ${math.number(exitPrice).toFixed(8)}`),
                    size: isLiquidated ? chalk.dim("N/A") : chalk.yellow(`${math.number(currentPositionSize).toFixed(2)} units`),
                    exposedAmount: exposedAmount,
                    leverage: chalk.blue("x" + math.number(leverage).toFixed(2)),
                    pnl: pnl,
                    status: status,
                    balance: balance,
                    fees: chalk.green(`Entry Fee: ${currencyFormatterUSD(math.number(totalEntryFee))}, Exit Fee: ${currencyFormatterUSD(math.number(totalExitFee))}`)
                });

                // Handle liquidation specifics
                if (isLiquidated) {
                    liquidated = true;
                    capital = math.bignumber(0); // Ensure capital doesn't go negative
                    console.log(`Trade ${totalTrades}: Liquidated. Final balance: $0.00 / KES 0.00.`);
                    break; // Stop trading
                }


                console.log(`Trade ${totalTrades}: PNL: ${balanceChange.toFixed(2)} USD`);

                // Logic to open the next trade
                if (capital < startingCapital) {
                    liquidated = true;
                    break;
                }

                // Set position size and decide on the next trade
                currentPositionSize = math.bignumber(math.multiply(currentPositionSize, winrate ? 1.5 : 2));
            } catch (error) {
                // Handle and log any unexpected errors
                console.error(chalk.red(`Error executing trade: ${error.message}`));
            }
        } else {
            console.log(`Position already open with ID: ${positionId}`);
            const position = positions[0]; // Assuming the first position is the relevant one
            const {
                symbol,
                positionAmt,
                entryPrice,
                markPrice,
                unRealizedProfit,
                liquidationPrice,
                leverage,
                marginType,
            } = position;

            // Use mathjs BigNumber for all calculations to ensure precision
            const positionAmtBN = math.bignumber(positionAmt); // Position size as BigNumber
            const entryPriceBN = math.bignumber(entryPrice); // Entry price as BigNumber
            const leverageBN = math.bignumber(leverage); // Leverage as BigNumber
            const unRealizedProfitBN = math.bignumber(unRealizedProfit); // Unrealized profit as BigNumber
            const marginUsed = math.abs(positionAmtBN) * entryPriceBN / leverageBN; // Margin used in USD

            // Determine if it's a loss or profit
            const isLoss = unRealizedProfitBN.lte(0);
            const action = isLoss ? 'futuresMarketSell' : 'futuresMarketBuy';
            const positionType = isLoss ? "SHORT" : "LONG";
            const positionColor = isLoss ? chalk.red : chalk.green;
            const status = isLoss ? "Loss" : "Profit";

            // Log position status
            console.log(positionColor(`Position is a ${status.toLowerCase()}. Closing...`));

            try {
                // Close the position (buy/sell)
                const response = await binance[action](symbol, positionAmt);

                // Check for error in the response
                if (response.code) {
                    console.log(chalk.red(`Error: ${response.msg}`));  // Log the error message from Binance
                } else {
                    // Record the trade to trade history after closing the position
                    pushToTradeHistory({
                        index: chalk.dim(totalTrades),
                        side: positionColor(positionType),  // SHORT or LONG based on loss or profit
                        symbol: chalk.gray(symbol),
                        price: chalk.blue(`${math.number(entryPriceBN).toFixed(8)} → ${math.number(markPrice).toFixed(8)}`), // Exit price as mark price
                        size: chalk.yellow(`${math.number(positionAmtBN).toFixed(2)} units`),
                        exposedAmount: positionColor(`${currencyFormatterUSD(math.number(marginUsed))}`),
                        leverage: positionColor("x" + math.number(leverageBN).toFixed(2)),
                        pnl: positionColor(`${currencyFormatterUSD(math.number(unRealizedProfitBN))}`),
                        status: positionColor(status),
                        balance: chalk.yellow(`${currencyFormatterUSD(math.number(capital))}`), // Adjust capital after closing the position
                        fees: positionColor(`Entry Fee: ${currencyFormatterUSD(math.number(totalEntryFee))}, Exit Fee: ${currencyFormatterUSD(math.number(totalExitFee))}`)
                    });
                }
            } catch (error) {
                console.error(chalk.red(`Error while closing position: ${error.message}`)); // Catch unexpected errors
            }


        }

    }

    // Print the final status and trade history in a table
    console.log();

    console.log("Simulation finished.");
    return {
        table: chalkTable(tableOptions, tradeHistory),
        startingCapital,
        totalTrades,
        finalCapital: math.number(capital),
        tradeHistory
    };
}


// Define your loop settings
const iterations = 10; // Number of times to run the simulation
let currentIteration = 0;

// Function to simulate the trades with risk management
const runSimulationLoop = async () => {
    while (currentIteration < iterations) {
        // Increment the iteration counter
        currentIteration++;

        console.log(`\nStarting Simulation Iteration ${currentIteration} of ${iterations}`);

        // Run the simulation for trades with risk management
        const result = await simulateTradesWithRiskManagement(startingCapital, winrate, targetCapital, leverage);

        // Print the results of the current simulation iteration
        console.log(result.table);
        console.log(`Iteration ${currentIteration} - Final Balance: $${result.finalCapital.toFixed(2)}`);

        // Check if the final capital has reached the target
        if (result.finalCapital >= targetCapital) {
            console.log(chalk.green("Target Capital Reached! Ending simulation."));
            break;
        }

        // Optionally, you can wait between iterations or add additional logic here
        // e.g., await new Promise(resolve => setTimeout(resolve, 2000)); // Delay 2 seconds
    }

    console.log("\nSimulation loop finished.");
};

// Start the simulation loop
runSimulationLoop();

