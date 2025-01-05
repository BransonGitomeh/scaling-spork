require("dotenv").config();
const Binance = require('node-binance-api');
const currency = require('currency.js');
const math = require('mathjs');
const moment = require('moment');
require('moment-duration-format');
const chalk = require('chalk');
const chalkTable = require('chalk-table');
require("dotenv").config();
let sound = require("sound-play");

const {
    priceCrossSMA,
    priceCrossEMA,
    getDetachSourceFromOHLCV,
    atr,
    sma,
    rsi,
    adx,
} = require('trading-indicator');

// Constants
const winrate = 0.3; // 70% winrate
const leverage = 75; // 100x leverage
let minNotional = 5.1
let symbol = "DEGOUSDT";
let exchange = 'binance'


let { BINANCE_API_KEY, BINANCE_SECRET_KEY } = process.env;
let binance = new Binance().options({
    APIKEY: BINANCE_API_KEY,
    APISECRET: BINANCE_SECRET_KEY,
    family: 4,
    // test: true, // Add this to enable test mode
});


const currencyFormatterUSD = (amount) => currency(amount?.toFixed(2), { symbol: '$ ', separator: ',', decimal: '.', precision: 2 })?.format();

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
        { field: "pnlROI", name: chalk.green("PNL ROI %") }, // PNL as ROI
        { field: "tpSlInfo", name: chalk.blue("TP/SL") }, // TP/SL for entire position
        { field: "balanceChange", name: chalk.blue("Balance Effect") }, // TP/SL for entire position,
        { field: "fees", name: chalk.blue("Fee Costs") }, // TP/SL for entire position

    ],
};

// Helper function to round price to the nearest tick size
function roundToTickSize(price, tickSize) {
    return Math.round(price / tickSize) * tickSize;
}

async function fetchOHLCVWithRetry(exchange, symbol, timeframe, retries = 30, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Fetching ${timeframe} data for ${symbol} (Attempt ${attempt})...`);
            const result = await getDetachSourceFromOHLCV(exchange, symbol, timeframe, true);
            return result; // Return the result if successful
        } catch (error) {
            // console.error(`Error fetching ${timeframe} data for ${symbol}:`, error);
            if (attempt < retries) {
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay)); // Wait before retrying
            } else {
                console.error(`Max retries (${retries}) reached. Giving up.`);
                throw error; // Re-throw the error if all retries fail
            }
        }
    }
}


const decideTradeDirection = async () => {
    const maPeriod = 7; // Moving Average period for short-term trend
    const rsiPeriod = 7; // RSI period for overbought/oversold conditions
    const adxPeriod = 7; // ADX period for trend strength
    const atrPeriod = 7; // ATR period for volatility
    const atrThreshold = 0.5; // Minimum volatility threshold for trading
    const recentPeriodCount = 5; // Check the last 5 periods for confirmation

    try {
        console.log('Starting trade direction decision process...');

        // Fetch input data for 1-minute and 3-minute timeframes for trend confirmation
        console.log('Fetching the latest price data for 1-minute and 3-minute timeframes...');
        const [{ input: input1m }, { input: input3m }] = await Promise.all([
            fetchOHLCVWithRetry(exchange, symbol, '1m'), // 1-minute data with retry
            fetchOHLCVWithRetry(exchange, symbol, '3m')  // 3-minute data with retry
        ]);


        // Validate input data to avoid errors in calculation
        if (!input1m?.close?.length || !input3m?.close?.length) {
            console.warn('Not enough data to make a decision. Skipping this cycle.');
            return null;
        }

        // Calculate technical indicators for both timeframes
        console.log('Calculating technical indicators (SMA, RSI, ADX, ATR) for both timeframes...');
        const [sma1m, sma3m, rsi1m, rsi3m, adx1m, adx3m, atr1m, atr3m] = await Promise.all([
            sma(maPeriod, 'close', input1m), // 1-minute SMA
            sma(maPeriod, 'close', input3m), // 3-minute SMA
            rsi(rsiPeriod, 'close', input1m), // 1-minute RSI
            rsi(rsiPeriod, 'close', input3m), // 3-minute RSI
            adx(adxPeriod, input1m), // 1-minute ADX
            adx(adxPeriod, input3m), // 3-minute ADX
            atr(atrPeriod, input1m), // 1-minute ATR
            atr(atrPeriod, input3m)  // 3-minute ATR
        ]);

        // Extract the last N values for decision making
        const recentRSI1m = rsi1m.slice(-recentPeriodCount); // Last 5 periods of RSI for 1m
        const recentRSI3m = rsi3m.slice(-recentPeriodCount); // Last 5 periods of RSI for 3m
        const recentADX1m = adx1m.slice(-recentPeriodCount).map(a => a.adx); // Last 5 periods of ADX for 1m
        const recentADX3m = adx3m.slice(-recentPeriodCount).map(a => a.adx); // Last 5 periods of ADX for 3m
        const recentATR1m = atr1m.slice(-recentPeriodCount); // Last 5 periods of ATR for 1m
        const recentATR3m = atr3m.slice(-recentPeriodCount); // Last 5 periods of ATR for 3m

        // Log the latest values for transparency
        console.log(`Evaluating last ${recentPeriodCount} periods...`);
        console.log(`1-minute RSI: ${recentRSI1m.join(', ')}`);
        console.log(`3-minute RSI: ${recentRSI3m.join(', ')}`);
        console.log(`1-minute ADX: ${recentADX1m.join(', ')}`);
        console.log(`3-minute ADX: ${recentADX3m.join(', ')}`);
        console.log(`1-minute ATR: ${recentATR1m.join(', ')}`);
        console.log(`3-minute ATR: ${recentATR3m.join(', ')}`);

        // Determine the trend based on SMAs
        console.log('Evaluating SMA for trend direction...');
        const smaTrend1m = input1m.close[input1m.close.length - 1] > sma1m[sma1m.length - 1] ? 'LONG' : 'SHORT';
        const smaTrend3m = input3m.close[input3m.close.length - 1] > sma3m[sma3m.length - 1] ? 'LONG' : 'SHORT';

        console.log(`1-minute SMA trend: ${smaTrend1m}`);
        console.log(`3-minute SMA trend: ${smaTrend3m}`);

        // Check RSI for trend confirmation
        console.log('Evaluating RSI for trend confirmation...');
        // RSI Trend Confirmation with explicit long/short checks
        const isRSIConfirmingLong = recentRSI1m.every(r => r > 55) && recentRSI3m.every(r => r > 55);
        const isRSIConfirmingShort = recentRSI1m.every(r => r < 45) && recentRSI3m.every(r => r < 45);

        // ADX for stronger trend confirmation
        const isStrongTrend = recentADX1m.every(a => a > 25) && recentADX3m.every(a => a > 25);

        // ATR for adaptive volatility check
        const isVolatile = recentATR1m.every(a => a > atrThreshold) && recentATR3m.every(a => a > atrThreshold);

        // Final decision based on multiple confirmations
        if (smaTrend1m === 'LONG' && smaTrend3m === 'LONG') {
            console.log(`Trade direction determined: ${smaTrend1m}.`);
            console.log(`Reason:`);
            console.log(`- SMA confirms a ${smaTrend1m} trend (1m SMA trend: ${smaTrend1m}, 3m SMA trend: ${smaTrend3m}).`);
            console.log(`- RSI confirms a ${isRSIConfirmingLong} trend (1m RSI: ${recentRSI1m.join(', ')}, 3m RSI: ${recentRSI3m.join(', ')}).`);
            console.log(`- ADX shows a strong trend (1m ADX: ${recentADX1m.join(', ')}, 3m ADX: ${recentADX3m.join(', ')}).`);
            console.log(`- ATR indicates high volatility (1m ATR: ${recentATR1m.join(', ')}, 3m ATR: ${recentATR3m.join(', ')}).`);
            return smaTrend1m;
        } else if (smaTrend1m === 'SHORT' && smaTrend3m === 'SHORT') {
            console.log(`Trade direction determined: ${smaTrend1m}.`);
            console.log(`Reason:`);
            console.log(`- SMA confirms a ${smaTrend1m} trend (1m SMA trend: ${smaTrend1m}, 3m SMA trend: ${smaTrend3m}).`);
            console.log(`- RSI confirms a ${isRSIConfirmingLong} trend (1m RSI: ${recentRSI1m.join(', ')}, 3m RSI: ${recentRSI3m.join(', ')}).`);
            console.log(`- ADX shows a strong trend (1m ADX: ${recentADX1m.join(', ')}, 3m ADX: ${recentADX3m.join(', ')}).`);
            console.log(`- ATR indicates high volatility (1m ATR: ${recentATR1m.join(', ')}, 3m ATR: ${recentATR3m.join(', ')}).`);
            return smaTrend1m;
        } else {
            console.log('No trade signal generated.');
            console.log(`Reason:`);
            // Log the status of each condition
            if (smaTrend1m !== smaTrend3m) {
                console.log(`- SMA trends do not match (1m SMA trend: ${smaTrend1m}, 3m SMA trend: ${smaTrend3m}).`);
            }

            if (!isRSIConfirmingLong) {
                console.log(`- RSI does not confirm a trend (1m RSI: ${recentRSI1m.join(', ')}, 3m RSI: ${recentRSI3m.join(', ')}).`);
            } else {
                console.log(`- RSI confirms a ${isRSIConfirmingLong} trend (1m RSI: ${recentRSI1m.join(', ')}, 3m RSI: ${recentRSI3m.join(', ')}).`);
            }

            if (!isStrongTrend) {
                console.log(`- ADX shows a weak trend (1m ADX: ${recentADX1m.join(', ')}, 3m ADX: ${recentADX3m.join(', ')}).`);
            } else {
                console.log(`- ADX shows a strong trend (1m ADX: ${recentADX1m.join(', ')}, 3m ADX: ${recentADX3m.join(', ')}).`);
            }

            if (!isVolatile) {
                console.log(`- ATR indicates low volatility (1m ATR: ${recentATR1m.join(', ')}, 3m ATR: ${recentATR3m.join(', ')}).`);
            } else {
                console.log(`- ATR indicates high volatility (1m ATR: ${recentATR1m.join(', ')}, 3m ATR: ${recentATR3m.join(', ')}).`);
            }

            return null;
        }
    } catch (error) {
        console.error('Error during trend determination:', error);
        return null;
    }
};



async function fetchSymbolPrecision(symbol) {
    const exchangeInfo = await binance.futuresExchangeInfo();
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
    if (!symbolInfo) throw new Error(`Symbol ${symbol} not found.`);

    const tickSize = parseFloat(symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize);
    const lotSize = parseFloat(symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);

    return { tickSize, lotSize };
}

function roundToPrecision(value, precision) {
    const factor = 1 / precision;
    return Math.round(value * factor) / factor;
}




let previousCapital
let previousDirection
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
    previousBalance = capital
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
    let trendStrength = math.bignumber(0);  // Trend strength for win rate adjustment

    async function fetchMarkPrice() {
        try {
            // Fetch the mark price data for all symbols
            const response = await binance.futuresMarkPrice();

            // Find the object in the array that matches the given symbol
            const symbolData = response.find(item => item.symbol === symbol);

            // Check if the symbol data was found
            if (!symbolData) {
                throw new Error(`Symbol ${symbol} not found in mark price data`);
            }

            // Check if the mark price is available
            if (!symbolData.markPrice) {
                throw new Error(`Failed to fetch mark price for symbol ${symbol}`);
            }

            // Parse and return the mark price as a float
            const markPrice = parseFloat(symbolData.markPrice);
            return markPrice;
        } catch (error) {
            console.error("Error fetching mark price:", error);
            throw error; // Rethrow the error or return a fallback value if necessary
        }
    }


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

    // Constants for modes
    const MODES = {
        MARTINGALE: "martingale",
        ANTI_MARTINGALE: "anti-martingale",
        CURRENT: "current"
    };

    // Current mode (can switch dynamically)
    let currentMode = MODES.MARTINGALE;

    async function getBinanceServerTime() {
        try {
            const serverTime = await binance.futuresTime();
            return serverTime.serverTime;
        } catch (error) {
            console.error('Error fetching Binance server time:', error);
            throw error;
        }
    }

    const monitorOpenPositions = async () => {
        // try {
        // Fetch Binance server time
        const timestamp = await getBinanceServerTime();
        const recvWindow = 10000; // 10 seconds

        // Fetch open positions with correct timestamp and recvWindow
        const openPositions = await binance.futuresPositionRisk({ symbol, timestamp, recvWindow });
        if (openPositions.code) {
            console.error(`Error fetching positions: ${openPositions.msg}`);
            return false; // Return false to indicate an error
        }

        // Filter active positions with non-zero quantity
        const activePositions = openPositions.filter(pos => parseFloat(pos.positionAmt) !== 0);

        // Fetch current market direction
        const currentTradeDirection = await decideTradeDirection();

        for (const position of activePositions) {
            console.log(`Monitoring active position for ${position.symbol}...`);

            let positionClosed = false;
            while (!positionClosed) {
                // Fetch updated positions and balance with correct timestamp and recvWindow
                const [updatedPositions, balance] = await Promise.all([
                    binance.futuresPositionRisk({ symbol: position.symbol, timestamp, recvWindow }),
                    binance.futuresBalance({ timestamp, recvWindow })
                ]);

                if (updatedPositions.code) {
                    console.error(`Error fetching positions risk: ${updatedPositions.msg}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                const currentPosition = updatedPositions.find(pos => parseFloat(pos.positionAmt) !== 0);

                if (!currentPosition) {
                    // Position is closed
                    positionClosed = true;
                    sound.play("/Users/_bran/Documents/Trading/coin-flip-88793.mp3");

                    // Update capital and fees
                    const newCapital = parseFloat(balance.find(asset => asset.asset === 'USDT').balance);
                    const profitLoss = math.subtract(math.bignumber(newCapital), previousCapital);
                    capital = newCapital;

                    const entryFeeAmount = math.multiply(previousCapital, 0.00018);
                    const exitFeeAmount = math.multiply(math.abs(profitLoss), 0.00045);
                    totalFees = math.add(totalFees, math.add(entryFeeAmount, exitFeeAmount));
                    capital = math.subtract(math.add(capital, profitLoss), math.add(entryFeeAmount, exitFeeAmount));

                    // Determine if the trade was a win or loss
                    const isWin = math.larger(profitLoss, 0);

                    // Update win/loss counters and trend strength
                    if (isWin) {
                        consecutiveWins = math.add(consecutiveWins, 1);
                        consecutiveLosses = math.bignumber(0);
                        profitableTrades++;
                        trendStrength = math.min(math.add(trendStrength, 1), math.bignumber(5)); // Increase trend strength on win
                    } else {
                        consecutiveLosses = math.add(consecutiveLosses, 1);
                        consecutiveWins = math.bignumber(0);
                        trendStrength = math.max(math.subtract(trendStrength, 1), math.bignumber(-5)); // Decrease trend strength on loss
                    }

                    // Update high water mark
                    if (math.larger(capital, highWaterMark)) {
                        highWaterMark = capital;
                    }

                    //Define positionSize based on the absolute value of the position amount
                    const positionSize = math.abs(parseFloat(position.positionAmt)); // Calculate the size of the position


                    // Determine if the closed position was long or short
                    const wasLong = parseFloat(position.positionAmt) > 0; // Check if the position was long

                    // Update long/short trade tracking
                    if (wasLong) {
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

                    return true; // Signal that the position is closed
                }

                // Determine the position's direction (long or short)
                const positionDirection = parseFloat(currentPosition.positionAmt) > 0 ? 'long' : 'short';

                // Determine action and calculate prices
                const isShort = currentTradeDirection?.toLowerCase() === 'short';

                // Opposite action: SELL for long, BUY for short
                const oppositeAction = isShort ? 'BUY' : 'SELL';

                // Log if market direction changes
                if (currentTradeDirection && positionDirection?.toLowerCase() !== currentTradeDirection?.toLowerCase()) {
                    console.log(`Market direction changed from ${positionDirection.toUpperCase()} to ${currentTradeDirection}.`);
                    sound.play("/Users/_bran/Documents/Trading/e-piano-key-note-f_95bpm_F_minor.wav");
                    //  return false
                    // Prepare orders to close the position
                    const closeOrders = [
                        {
                            symbol,
                            side: oppositeAction, // Opposite of the current position's direction
                            type: "MARKET",
                            quantity: math.number(math.abs(parseFloat(currentPosition.positionAmt))).toString(), // Use the absolute value of positionAmt
                        },
                    ];

                    // Execute the close orders
                    const closeResponse = await binance.futuresMultipleOrders(closeOrders);

                    let allCloseOrdersSuccessful = true;

                    closeResponse.forEach((order, index) => {
                        if (order.code) {
                            // Handle failed orders
                            console.error(`Error in closing order ${index + 1}: ${order.msg}`);
                            allCloseOrdersSuccessful = false; // Flag error
                        } else {
                            // Handle successful orders
                            console.log(`Closing order ${index + 1} placed successfully:`, {
                                orderId: order.orderId,
                                symbol: order.symbol,
                                status: order.status,
                                side: order.side,
                                type: order.type,
                                quantity: order.origQty,
                                price: order.price,
                                time: new Date(order.updateTime).toLocaleString(),
                            });
                        }
                    });

                    if (allCloseOrdersSuccessful) {
                        sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
                        console.log("Position closed successfully.");
                    } else {
                        console.error("Failed to close the position.");
                    }
                }

                // Update previous direction
                previousDirection = currentTradeDirection;

                // Wait before checking again
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return false; // No position was closed
        // } catch (error) {
        //     console.error('Error monitoring positions:', error);
        //     return false; // Signal an error
        // }
    };


    const executeTrade = async () => {
        try {
            // Fetch Binance server time
            const timestamp = await getBinanceServerTime();
            const recvWindow = 10000; // 10 seconds

            // Check if there are any open positions on Binance
            const openPositions = await binance.futuresPositionRisk({ symbol: symbol, timestamp, recvWindow });

            if (openPositions.code) {
                console.error(`Error fetching positions: ${openPositions.msg}`);
                return false; // Stop execution on error
            }

            // Filter active positions with non-zero quantity
            const activePositions = openPositions.filter(pos => parseFloat(pos.positionAmt) !== 0);

            if (activePositions.length > 0) {
                // Monitor the existing position
                console.log('An open position already exists. Monitoring the position...');
                await monitorOpenPositions();
                return true; // Continue the loop after monitoring
            }

            // No open position, but check for leftover SL/TP orders
            console.log('No open position found. Checking for leftover SL/TP orders...');

            // Fetch open orders
            const openOrders = await binance.futuresOpenOrders();

            if (openOrders.code) {
                console.error(`Error fetching open orders: ${openOrders.msg}`);
                return false; // Stop execution on error
            }

            // Cancel all open orders (SL/TP)
            if (openOrders.length > 0) {
                console.log(`Found ${openOrders.length} leftover orders. Cancelling them...`);

                for (const order of openOrders) {
                    const cancelResponse = await binance.futuresCancel(symbol, { orderId: order.orderId, timestamp, recvWindow });

                    if (cancelResponse.code) {
                        console.error(`Error canceling order ${order.orderId}: ${cancelResponse.msg}`);
                    } else {
                        console.log(`Order ${order.orderId} canceled successfully:`, cancelResponse);
                    }
                }
            } else {
                console.log('No leftover orders found.');
            }

            // Now proceed to open a new position
            console.log('No open position found. Opening a new position...');

            // Fetch the current market direction
            const currentTradeDirection = await decideTradeDirection();
            if (!currentTradeDirection) {
                console.log('No valid trade direction determined. Stopping execution.');
                return false; // Stop execution if no valid direction
            }

            // Check if the trend has changed compared to the previous direction
            if (previousDirection && previousDirection !== currentTradeDirection) {
                console.log(`Trend changed from ${previousDirection} to ${currentTradeDirection}. Preparing to open a new position.`);
            }

            totalTrades++;
            previousCapital = capital;

            // Determine trade direction based on currentTradeDirection
            const goLong = currentTradeDirection.toLowerCase() === 'long';

            // Set markPrice and calculate TP and SL based on the trade direction
            const markPrice = await fetchMarkPrice(); // Example current price
            let tpPrice, slPrice;

            // Set markPrice and calculate TP and SL based on the trade direction
            const desiredWinPnL = 0.40; // 30% profit on capital
            const desiredLossPnL = 0.10; // 10% loss on capital

            if (goLong) {
                tpPrice = markPrice * (1 + (desiredWinPnL / leverage)); // TP for long (30% win)
                slPrice = markPrice * (1 - (desiredLossPnL / leverage)); // SL for long (10% loss)
            } else {
                tpPrice = markPrice * (1 - (desiredWinPnL / leverage)); // TP for short (30% win)
                slPrice = markPrice * (1 + (desiredLossPnL / leverage)); // SL for short (10% loss)
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


            // Determine action and calculate prices
            const isShort = currentTradeDirection.toLowerCase() === 'short';

            // Main action: BUY for long, SELL for short
            const action = isShort ? 'SELL' : 'BUY';

            // Opposite action: SELL for long, BUY for short
            const oppositeAction = isShort ? 'BUY' : 'SELL';

            // const tickSize = await fetchTickSize(symbol);
            const { tickSize, lotSize } = await fetchSymbolPrecision(symbol);

            // / Round price and quantity to the correct precision
            const roundPrice = (price) => roundToPrecision(price, tickSize);
            const roundQuantity = (quantity) => roundToPrecision(quantity, lotSize);

            // Prepare orders
            const orders = [
                { symbol, side: action, type: "MARKET", quantity: roundQuantity(math.number(notionalSize)).toString() },
                { symbol, side: oppositeAction, type: "LIMIT", quantity: roundQuantity(math.number(notionalSize)).toString(), price: roundPrice(tpPrice).toString(), timeInForce: "GTC" },
                { symbol, side: oppositeAction, type: "STOP_MARKET", quantity: roundQuantity(math.number(notionalSize)).toString(), stopPrice: roundPrice(slPrice).toString() }
            ];

            const response = await binance.futuresMultipleOrders(orders);

            let allOrdersSuccessful = true;

            response.forEach((order, index) => {
                if (order.code) {
                    // Handle failed orders
                    console.error(`Error in order ${index + 1}: ${order.msg}`);
                    allOrdersSuccessful = false; // Flag error
                } else {
                    // Handle successful orders
                    console.log(`Order ${index + 1} placed successfully:`, {
                        orderId: order.orderId,
                        symbol: order.symbol,
                        status: order.status,
                        side: order.side,
                        type: order.type,
                        quantity: order.origQty,
                        price: order.price,
                        time: new Date(order.updateTime).toLocaleString(),
                    });
                }
            });

            sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");

            await new Promise(resolve => setTimeout(resolve, 2000));

            // Monitor the position until it's closed
            let positionClosed = false;
            while (!positionClosed) {
                positionClosed = await monitorOpenPositions();
                if (!positionClosed) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Return the status based on the orders' success
            return allOrdersSuccessful;
        } catch (error) {
            console.error('Error in executeTrade:', error);
            return false; // Stop execution on error
        }
    };

    // Main trading loop
    const cooldownDuration = 1 * 60 * 1000; // 1 minute in milliseconds

    const runTradingLoop = async () => {
        while (true) {
            // Execute a trade
            const tradeSuccessful = await executeTrade();

            // Break the loop if the maximum number of trades is reached
            if (totalTrades >= 1000) {
                console.log('Maximum number of trades reached. Stopping the trading loop.');
                break;
            }

            // Break the loop if the trade was not successful
            if (!tradeSuccessful) {
                // Wait for the cooldown duration before the next iteration
                console.log(`Waiting for cooldown (${cooldownDuration / 1000} seconds)...`);
                await new Promise(resolve => setTimeout(resolve, cooldownDuration));
            }

            // Check if the current capital has reached or exceeded the target capital
            if (capital >= targetCapital) {
                console.log(`Target capital of ${targetCapital} reached. Stopping the trading loop.`);
                break;
            }
        }
    };

    // Start the trading loop and wait for it to finish
    try {
        await runTradingLoop();
    } catch (error) {
        console.error('Error in trading loop:', error);
    }



    // Calculate final statistics
    const finalStats = {
        totalTrades,
        trades,
        profitableTrades,
        table: chalkTable(tableOptions, trades),
        winRate: math.number(math.multiply(
            math.divide(math.bignumber(profitableTrades), math.bignumber(totalTrades)),
            100
        )),
        finalCapital: math.bignumber(capital),
        totalFees: math.number(totalFees),
        returnOnInvestment: math.number(math.multiply(
            math.subtract(math.divide(capital, capitalBN), 1),
            100
        )),
        maxDrawdown: trades.length === 0 ? 0 : math.number(
            math.multiply(
                math.subtract(
                    1,
                    math.divide(
                        math.bignumber(math.min(...trades.map(t => parseFloat(t.balance.replace(/[^0-9.-]+/g, ""))))),
                        math.bignumber(highWaterMark) // Convert highWaterMark to BigNumber
                    )
                ),
                100
            )
        )
    };

    return finalStats;
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

let savings = math.bignumber(0);
let savingsRate = 0.2; // Save 20% of profits at the end of each stage


async function runSimulationInStages(startingCapital, targetGoal, winrate, leverage) {
    let currentCapital = math.bignumber(startingCapital);
    let overallTarget = math.bignumber(targetGoal);
    let stageTargetMultiplier = math.bignumber(15.75);
    let stageCount = 1;

    while (math.smaller(currentCapital, overallTarget)) {
        console.log(chalk.cyan(`\n=== Stage ${stageCount} ===`));
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

        // Process results and update capital/savings
        const stageProfit = math.subtract(result.finalCapital, currentCapital);
        if (math.larger(stageProfit, 0)) {
            const savingsAmount = math.multiply(stageProfit, savingsRate);
            savings = math.add(savings, savingsAmount);
            currentCapital = math.subtract(result.finalCapital, savingsAmount);
            console.log(chalk.green(`Saved ${currencyFormatterUSD(math.number(savingsAmount))} to savings.`));
        } else {
            currentCapital = math.bignumber(result.finalCapital);
        }

        console.log(chalk.yellow(`Updated Capital: ${currencyFormatterUSD(math.number(currentCapital))}`));
        console.log(chalk.yellow(`Total Savings: ${currencyFormatterUSD(math.number(savings))}`));

        // Check if the stage goal is achieved
        if (math.largerEq(result.finalCapital, nextTarget)) {
            console.log(chalk.green(`Stage ${stageCount} goal achieved!`));
            stageCount++; // Increment stage count only if the goal is achieved
        } else {
            console.log(chalk.red(`Stage ${stageCount} goal not achieved. Retrying stage.`));
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

    console.log(chalk.green(`\nSimulation complete!`));
    console.log(chalk.gray(`Final Trading Capital: `) + chalk.green(currencyFormatterUSD(math.number(currentCapital))));
    console.log(chalk.gray(`Total Savings: `) + chalk.green(currencyFormatterUSD(math.number(savings))));
    console.log(chalk.gray(`Overall Net Worth: `) + chalk.green(currencyFormatterUSD(math.add(currentCapital, savings))));

    console.log(chalk.green(`\nSimulation complete!`));
    console.log(chalk.gray(`Final Capital: `) + chalk.green(currencyFormatterUSD(math.number(currentCapital))));

    // After the simulation is complete, display combined results for longs and shorts
    console.log(chalk.cyan('\nCombined Results for Longs and Shorts:'));
    console.log(chalk.gray(`Total Long Trades: `) + chalk.green(totalLongs));
    console.log(chalk.gray(`Total Short Trades: `) + chalk.green(totalShorts));
    console.log(chalk.gray(`Total Long PnL: `) + chalk.green(currencyFormatterUSD(totalLongsPnl)));
    console.log(chalk.gray(`Total Short PnL: `) + chalk.green(currencyFormatterUSD(totalShortsPnl)));
    console.log(chalk.gray(`Total Long Size: `) + chalk.green(`${totalLongsSize}%`));
    console.log(chalk.gray(`Total Short Size: `) + chalk.green(`${totalShortsSize}%`));
    console.log(chalk.gray(`Total Long Fees: `) + chalk.green(currencyFormatterUSD(totalLongsFees)));
    console.log(chalk.gray(`Total Short Fees: `) + chalk.green(currencyFormatterUSD(totalShortsFees)));

    console.log(chalk.cyan('\nOverall Simulation Summary:'));
    console.log(chalk.gray(`Total Trades: `) + chalk.green(totalLongs + totalShorts));
    console.log(chalk.gray(`Total PnL: `) + chalk.green(currencyFormatterUSD(totalLongsPnl + totalShortsPnl)));
    console.log(chalk.gray(`Total Fees: `) + chalk.green(currencyFormatterUSD(totalLongsFees + totalShortsFees)));

    // Example for losses in red:
    if (totalLongsPnl < 0) {
        console.log(chalk.red(`Loss in Long PnL: `) + chalk.green(currencyFormatterUSD(totalLongsPnl)));
    }
    if (totalShortsPnl < 0) {
        console.log(chalk.red(`Loss in Short PnL: `) + chalk.green(currencyFormatterUSD(totalShortsPnl)));
    }
}

// Example usage
const innitialStartingCapital = 0.3; // Initial capital in USDT
const targetGoal = math.bignumber(100.00); // Final goal in USDT

runSimulationInStages(innitialStartingCapital, targetGoal, winrate, leverage);
