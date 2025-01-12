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
    ema,
    vwap
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

function summarizeWalls(walls) {
    const deltas = walls.map((w) => w.delta);
    const count = deltas.length;
    const preview = deltas
        .slice(0, MAX_WALLS_TO_SHOW)
        .map((delta) => delta.toFixed(2));
    const minDelta = Math.min(...deltas).toFixed(2);
    const maxDelta = Math.max(...deltas).toFixed(2);
    const avgDelta = (deltas.reduce((sum, d) => sum + d, 0) / count).toFixed(2);

    return {
        preview: preview.join(", "),
        count,
        min: minDelta,
        max: maxDelta,
        avg: avgDelta,
    };
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

let previousState = {
    volumes: { buyVolume: 0, sellVolume: 0 },
    price: 0,
    walls: { buyWalls: [], sellWalls: [] },
};
const MAX_WALLS_TO_SHOW = 3; // Limit the number of entries shown

// Analyze buy and sell wall changes
const analyzeWallChanges = (buyWalls, sellWalls, previousState) => {
    const buyWallChanges = buyWalls.map((wall, index) => {
        const prevWall = previousState.walls?.buyWalls[index] || { q: 0 };
        const currentQty = parseFloat(wall.q);
        const prevQty = parseFloat(prevWall.q);
        const delta = currentQty - prevQty;

        return {
            price: wall.p,
            currentQty,
            prevQty,
            delta: isNaN(delta) ? 0 : delta,
        };
    });

    const sellWallChanges = sellWalls.map((wall, index) => {
        const prevWall = previousState.walls?.sellWalls[index] || { q: 0 };
        const currentQty = parseFloat(wall.q);
        const prevQty = parseFloat(prevWall.q);
        const delta = currentQty - prevQty;

        return {
            price: wall.p,
            currentQty,
            prevQty,
            delta: isNaN(delta) ? 0 : delta,
        };
    });

    return { buyWallChanges, sellWallChanges };
};

// Log wall changes for better insights
const logWallChanges = (buyWallChanges, sellWallChanges) => {
    console.log('Buy Wall Changes:');
    buyWallChanges.forEach((wall, index) => {
        console.log(`Buy Wall ${index}: Price = ${wall.price}, Current Qty = ${wall.currentQty}, Previous Qty = ${wall.prevQty}, Delta = ${wall.delta.toFixed(2)}`);
    });

    console.log('Sell Wall Changes:');
    sellWallChanges.forEach((wall, index) => {
        console.log(`Sell Wall ${index}: Price = ${wall.price}, Current Qty = ${wall.currentQty}, Previous Qty = ${wall.prevQty}, Delta = ${wall.delta.toFixed(2)}`);
    });
};

// Calculate percentile threshold for buy/sell orders
const calculatePercentileThreshold = (orders, percentile) => {
    if (!orders || orders.length === 0) {
        console.warn('No orders provided for threshold calculation.');
        return 0;
    }

    // Extract valid quantities
    const quantities = orders
        .map((order) => parseFloat(order.q))
        .filter((q) => !isNaN(q) && q > 0); // Filter out invalid quantities

    if (quantities.length === 0) {
        console.warn('No valid quantities found in orders.');
        return 0;
    }

    // Sort quantities in ascending order
    quantities.sort((a, b) => a - b);

    // Calculate the index for the given percentile
    const index = Math.ceil((percentile / 100) * quantities.length) - 1;
    return quantities[index] || 0;
};

const analyzeOrderBook = (orderBook) => {
    // Extract bids and asks from the order book
    const bids = orderBook.bids.map((bid) => ({ p: bid[0], q: bid[1] })); // Convert to { p, q } format
    const asks = orderBook.asks.map((ask) => ({ p: ask[0], q: ask[1] })); // Convert to { p, q } format

    // Cache best bid/ask and mid-price
    const bestBid = bids.length > 0 ? Math.max(...bids.map((bid) => parseFloat(bid.p))) : 0;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map((ask) => parseFloat(ask.p))) : Infinity;
    const midPrice = (bestBid + bestAsk) / 2;

    // Calculate total buy and sell volume with validation
    const buyVolume = bids.reduce((sum, bid) => {
        const quantity = parseFloat(bid.q);
        return sum + (isNaN(quantity) ? 0 : quantity); // Fallback to 0 if quantity is NaN
    }, 0);

    const sellVolume = asks.reduce((sum, ask) => {
        const quantity = parseFloat(ask.q);
        return sum + (isNaN(quantity) ? 0 : quantity); // Fallback to 0 if quantity is NaN
    }, 0);

    const totalVolume = buyVolume + sellVolume;

    // Order Book Imbalance
    const imbalance = (buyVolume - sellVolume) / totalVolume;

    // VWAP Calculation (Volume-Weighted Average Price)
    const vwap =
        (bids.reduce((sum, bid) => sum + parseFloat(bid.p) * parseFloat(bid.q), 0) +
            asks.reduce((sum, ask) => sum + parseFloat(ask.p) * parseFloat(ask.q), 0)) /
        totalVolume;

    // Price Clusters (zones of high liquidity)
    const detectPriceClusters = (orders, threshold) => {
        const priceBuckets = new Map();
        orders.forEach((order) => {
            const price = parseFloat(order.p);
            const quantity = parseFloat(order.q);
            if (!isNaN(price) && !isNaN(quantity)) { // Only process valid numbers
                const bucket = Math.round(price / threshold) * threshold;
                priceBuckets.set(bucket, (priceBuckets.get(bucket) || 0) + quantity);
            }
        });
        return Array.from(priceBuckets.entries()).sort((a, b) => b[1] - a[1]);
    };

    const buyClusters = detectPriceClusters(bids, 0.5);
    const sellClusters = detectPriceClusters(asks, 0.5);

    // Detect price walls (large orders)
    const detectPriceWalls = (orders, volumeThreshold) => {
        if (!orders || orders.length === 0) {
            console.warn('No orders provided for wall detection.');
            return [];
        }

        return orders.filter((order) => {
            const quantity = parseFloat(order.q);
            return !isNaN(quantity) && quantity >= volumeThreshold; // Only include valid orders
        });
    };

    // Example usage
    const buyThreshold = calculatePercentileThreshold(bids, 95); // Top 10% of buy orders
    const sellThreshold = calculatePercentileThreshold(asks, 95); // Top 10% of sell orders

    const buyWalls = detectPriceWalls(bids, buyThreshold);
    const sellWalls = detectPriceWalls(asks, sellThreshold);

    const { buyWallChanges, sellWallChanges } = analyzeWallChanges(buyWalls, sellWalls, previousState);
    logWallChanges(buyWallChanges, sellWallChanges);

    // Order Flow Velocity (change in volume over time)
    const orderFlowVelocity = {
        buy: buyVolume - (previousState.volumes?.buyVolume || 0),
        sell: sellVolume - (previousState.volumes?.sellVolume || 0),
    };

    // Wall Exhaustion Analysis (change in wall size over time)
    const wallExhaustion = {
        buy: buyWalls.map((wall, index) => {
            const prevWall = previousState.walls?.buyWalls[index] || { q: 0 };
            const currentQty = parseFloat(wall.q);
            const prevQty = parseFloat(prevWall.q);

            const delta = currentQty - prevQty;
            return { price: wall.p, delta: isNaN(delta) ? 0 : delta }; // Handle invalid deltas
        }),
        sell: sellWalls.map((wall, index) => {
            const prevWall = previousState.walls?.sellWalls[index] || { q: 0 };
            const currentQty = parseFloat(wall.q);
            const prevQty = parseFloat(prevWall.q);

            const delta = currentQty - prevQty;
            return { price: wall.p, delta: isNaN(delta) ? 0 : delta }; // Handle invalid deltas
        }),
    };

    // Update previous state for the next iteration
    previousState.walls = {
        buyWalls: buyWalls,
        sellWalls: sellWalls,
    };

    // Predictive Signal Generation
    let signal = "Neutral";
    const priceMovement = midPrice - (previousState.price || midPrice);
    const volumeDelta = buyVolume - sellVolume;

    if (volumeDelta > 100 && priceMovement > 0) signal = "Bullish Confirmation";
    else if (volumeDelta < -100 && priceMovement < 0) signal = "Bearish Confirmation";

    // === Extreme Prices and Quantities ===
    const extremePrices = {
        highestPrice: asks.length > 0 ? Math.max(...asks.map((ask) => parseFloat(ask.p))) : null,
        lowestPrice: bids.length > 0 ? Math.min(...bids.map((bid) => parseFloat(bid.p)).filter((p) => !isNaN(p))) : null,
    };

    const extremeQuantities = {
        highestPriceQuantity: asks.length > 0
            ? asks.find((ask) => parseFloat(ask.p) === extremePrices.highestPrice)?.q || 0
            : 0,
        lowestPriceQuantity: bids.length > 0
            ? bids.find((bid) => parseFloat(bid.p) === extremePrices.lowestPrice)?.q || 0
            : 0,
    };

    // Log Outputs
    console.log("\n=== Order Book Analysis ===");
    console.log({
        "Best Bid": bestBid.toFixed(4),
        "Best Ask": bestAsk.toFixed(4),
        "Mid Price": midPrice.toFixed(4),
        "VWAP": vwap.toFixed(4),
        "Imbalance": imbalance.toFixed(4),
        "Signal": signal,
    });

    console.log("\n=== Order Flow Velocity ===");
    console.log({
        "Buy Flow": orderFlowVelocity.buy.toFixed(2),
        "Sell Flow": orderFlowVelocity.sell.toFixed(2),
    });

    console.log("\n=== Price Clusters ===");
    console.log({
        "Buy Clusters": buyClusters.map(([price, volume]) => `${price}: ${volume.toFixed(2)}`),
        "Sell Clusters": sellClusters.map(([price, volume]) => `${price}: ${volume.toFixed(2)}`),
    });

    console.log("\n=== Price Walls ===");
    console.log({
        "Buy Walls": buyWalls.map((wall) => {
            const quantity = parseFloat(wall.q); // Convert to number
            return `${wall.p}: ${isNaN(quantity) ? "N/A" : quantity}`; // Handle invalid numbers
        }).join("\n"),
        "Sell Walls": sellWalls.map((wall) => {
            const quantity = parseFloat(wall.q); // Convert to number
            return `${wall.p}: ${isNaN(quantity) ? "N/A" : quantity}`; // Handle invalid numbers
        }).join("\n"),
    });

    console.log("\n=== Wall Exhaustion ===");
    console.log({
        "Buy Wall Deltas": wallExhaustion.buy.length > 0
            ? wallExhaustion.buy.map((wall) => `${wall.price}: ${wall.delta.toFixed(2)}`).join("\n")
            : "No buy wall deltas found",
        "Sell Wall Deltas": wallExhaustion.sell.length > 0
            ? wallExhaustion.sell.map((wall) => `${wall.price}: ${wall.delta.toFixed(2)}`).join("\n")
            : "No sell wall deltas found",
    });

    console.log("\n=== Extreme Prices and Quantities ===");
    console.log({
        "Highest Price": extremePrices.highestPrice,
        "Quantity at Highest Price": extremeQuantities.highestPriceQuantity,
        "Lowest Price": extremePrices.lowestPrice,
        "Quantity at Lowest Price": extremeQuantities.lowestPriceQuantity,
    });

    console.log("\n=== Trading Advice ===");
    if (signal === "Bullish Confirmation") {
        console.log("🟢 Strong Buy Signal: Consider entering a long position or adding to existing longs.");
    } else if (signal === "Bearish Confirmation") {
        console.log("🔴 Strong Sell Signal: Consider entering a short position or adding to existing shorts.");
    } else {
        console.log("🟡 Neutral Signal: Wait for clearer market direction.");
    }

    // Update previous state
    previousState = {
        price: midPrice,
        volumes: { buyVolume, sellVolume },
        walls: { buyWalls, sellWalls },
    };

    // Return analysis results
    return {
        bestBid,
        bestAsk,
        midPrice,
        vwap,
        imbalance,
        buyClusters,
        sellClusters,
        buyWalls,
        sellWalls,
        orderFlowVelocity,
        wallExhaustion,
        signal,
        volumes: { buyVolume, sellVolume },
        price: midPrice,
        extremePrices,
        extremeQuantities,
    };
};

let analyzeVolume = (aggTrades = [], openPosition = false) => {
    // Extract volume data and calculate average volume
    let volumeData = aggTrades.map((t) => parseFloat(t.q));
    let avgVolume = volumeData.reduce((sum, v) => sum + v, 0) / volumeData.length;
    let currentVolume = parseFloat(aggTrades[aggTrades.length - 1]?.q);

    // Define thresholds for decision-making
    const volumeSpikeThreshold = 1.5; // 150% of average volume
    const volumeDropThreshold = 0.5; // 50% of average volume

    // Analyze current volume relative to average
    if (currentVolume > avgVolume * volumeSpikeThreshold) {
        if (!openPosition) {
            console.log("Entry Advice: Volume spike detected! Consider entering a trade.");
        } else {
            console.log("Position Management: Volume spike detected! Consider adding to your position or holding.");
        }
    } else if (currentVolume < avgVolume * volumeDropThreshold) {
        if (openPosition) {
            console.log("Position Management: Volume drop detected! Consider exiting or reducing your position.");
        } else {
            console.log("Entry Advice: Low volume detected. Avoid entering a trade.");
        }
    } else {
        if (!openPosition) {
            console.log("Entry Advice: Volume is normal. Wait for a better entry signal.");
        } else {
            console.log("Position Management: Volume is normal. Hold your position.");
        }
    }

    // Return volume data for further analysis
    return {
        currentVolume,
        avgVolume,
        volumeData,
    };
};

const cache = {
    data: null,
    timestamp: 0,
    banUntil: 0,
};

let fetchOrderBookData = async (symbol) => {
    // Check if we're banned or using cached data
    const now = Date.now();
    if (cache.banUntil > now) {
        console.log(
            chalk.yellow(
                `Using cached data due to ban until ${new Date(cache.banUntil).toISOString()}`,
            ),
        );
        return cache.data;
    }

    let orderBook = {
        bids: [],
        asks: [],
    };

    try {
        // Fetch live order book data
        orderBook = await binance.futuresDepth(symbol, { limit: 10 });

        // Cache the successful response
        cache.data = { orderBook };
        cache.timestamp = now;
        cache.banUntil = 0; // Reset ban duration
    } catch (err) {
        console.error(chalk.red(`Error fetching order book data: ${err.message}`));

        if (err.code == -1003 && err.msg.includes("Way too many requests")) {
            // Extract ban timestamp if present
            const banUntilMatch = err.msg.match(/banned until (\d+)/);
            const banUntil = banUntilMatch
                ? parseInt(banUntilMatch[1], 10)
                : now + 60000; // Default ban: 1 minute
            cache.banUntil = banUntil;
            console.log(
                chalk.yellow(
                    `IP banned until ${new Date(cache.banUntil).toISOString()}. Using cached data.`,
                ),
            );
        }

        // Return cached data if available
        if (cache.data) {
            console.log(chalk.yellow("Returning cached data due to error."));
            return cache.data;
        }
    }

    return { orderBook };
};



const decideTradeDirection = async (hasOpenPosition = false, orderBook) => {
    const emaPeriod1 = 5; // 5-period EMA
    const emaPeriod2 = 8; // 8-period EMA
    const emaPeriod3 = 13; // 13-period EMA
    const rsiPeriod = 5; // RSI period for overbought/oversold conditions
    const rsiThresholdUpper = 70; // Overbought threshold
    const rsiThresholdLower = 30; // Oversold threshold
    const adxPeriod = 5; // ADX period for trend strength
    const adxThreshold = 30; // ADX threshold for strong trend

    try {
        console.log('\nStarting trade direction decision process...');

        // Fetch input data for 1-minute timeframe
        console.log('Fetching the latest price data for 1-minute timeframe...');
        const { input: input1m } = await fetchOHLCVWithRetry(exchange, symbol, '5m'); // 1-minute data with retry

        // Validate input data to avoid errors in calculation
        if (!input1m?.close?.length) {
            console.warn('Not enough data to make a decision. Skipping this cycle.');
            return null;
        }

        // Calculate technical indicators for the 1-minute timeframe
        console.log('Calculating technical indicators (EMA5, EMA8, EMA13, RSI, ADX) for 1-minute timeframe...');
        const [ema5, ema8, ema13, rsi14, adx14] = await Promise.all([
            ema(emaPeriod1, 'close', input1m), // 5-period EMA
            ema(emaPeriod2, 'close', input1m), // 8-period EMA
            ema(emaPeriod3, 'close', input1m), // 13-period EMA
            rsi(rsiPeriod, 'close', input1m), // RSI
            adx(adxPeriod, input1m) // ADX
        ]);

        // Extract the latest values
        const latestClose = input1m.close[input1m.close.length - 1];
        const latestEma5 = ema5[ema5.length - 1];
        const latestEma8 = ema8[ema8.length - 1];
        const latestEma13 = ema13[ema13.length - 1];
        const latestRsi = rsi14[rsi14.length - 1];
        const latestAdx = adx14[adx14.length - 1]; // Contains { adx, pdi, mdi }

        console.log(`Latest Close: ${latestClose}`);
        console.log(`Latest EMA5: ${latestEma5}`);
        console.log(`Latest EMA8: ${latestEma8}`);
        console.log(`Latest EMA13: ${latestEma13}`);
        console.log(`Latest RSI: ${latestRsi}`);
        console.log(`Latest ADX: ${latestAdx.adx}`);
        console.log(`Latest PDI: ${latestAdx.pdi}`);
        console.log(`Latest MDI: ${latestAdx.mdi}`);

        // Determine the trend based on the 13-period EMA
        const isUptrend = latestClose > latestEma13;
        const isDowntrend = latestClose < latestEma13;

        // Determine the trade direction based on EMA crossovers and trend
        let tradeDirection = null;

        // Bullish signal: EMA5 crosses above EMA8 and both are above EMA13
        if (latestEma5 > latestEma8 && latestEma8 > latestEma13 && isUptrend) {
            console.log('Bullish signal detected: EMA5 crossed above EMA8 and both are above EMA13.');
            tradeDirection = 'LONG';
        }
        // Bearish signal: EMA5 crosses below EMA8 and both are below EMA13
        else if (latestEma5 < latestEma8 && latestEma8 < latestEma13 && isDowntrend) {
            console.log('Bearish signal detected: EMA5 crossed below EMA8 and both are below EMA13.');
            tradeDirection = 'SHORT';
        } else {
            console.log('No EMA crossover detected or price is not aligned with the 13-period EMA. Market is likely consolidating.');
        }

        // Confirm the trend with RSI and ADX
        if (tradeDirection === 'LONG') {
            if (latestRsi > rsiThresholdUpper) {
                console.log('RSI indicates overbought conditions. Cancelling LONG signal.');
                tradeDirection = null;
            } else if (latestAdx.adx < adxThreshold || latestAdx.pdi <= latestAdx.mdi) {
                console.log('ADX indicates weak trend strength or PDI is not greater than MDI. Cancelling LONG signal.');
                tradeDirection = null;
            }
        } else if (tradeDirection === 'SHORT') {
            if (latestRsi < rsiThresholdLower) {
                console.log('RSI indicates oversold conditions. Cancelling SHORT signal.');
                tradeDirection = null;
            } else if (latestAdx.adx < adxThreshold || latestAdx.mdi <= latestAdx.pdi) {
                console.log('ADX indicates weak trend strength or MDI is not greater than PDI. Cancelling SHORT signal.');
                tradeDirection = null;
            }
        }

        // Analyze the live order book for additional signal filtering


        let { orderBook } = await fetchOrderBookData(symbol);
        const orderBookAnalysis = analyzeOrderBook(orderBook);

        // Filter LONG signals using order book metrics
        // if (tradeDirection === 'LONG') {
        //     if (orderBookAnalysis.imbalance < 0) {
        //         console.log('Order book shows sell-side imbalance. Cancelling LONG signal.');
        //         tradeDirection = null;
        //     } else if (latestClose < orderBookAnalysis.vwap) {
        //         console.log('Price is below VWAP. Cancelling LONG signal.');
        //         tradeDirection = null;
        //     } else if (orderBookAnalysis.buyClusters.length === 0) {
        //         console.log('No strong buy-side price clusters detected. Cancelling LONG signal.');
        //         tradeDirection = null;
        //     }
        // }

        // // Filter SHORT signals using order book metrics
        // if (tradeDirection === 'SHORT') {
        //     if (orderBookAnalysis.imbalance > 0) {
        //         console.log('Order book shows buy-side imbalance. Cancelling SHORT signal.');
        //         tradeDirection = null;
        //     } else if (latestClose > orderBookAnalysis.vwap) {
        //         console.log('Price is above VWAP. Cancelling SHORT signal.');
        //         tradeDirection = null;
        //     } else if (orderBookAnalysis.sellClusters.length === 0) {
        //         console.log('No strong sell-side price clusters detected. Cancelling SHORT signal.');
        //         tradeDirection = null;
        //     }
        // }


        // If there is an open position, prioritize the current trend
        if (hasOpenPosition) {
            console.log('Open position detected. Prioritizing current trend...');
            return tradeDirection; // Return the current trend directly
        }

        // Final decision
        if (tradeDirection === 'LONG') {
            console.log('Decision: Go LONG.');
        } else if (tradeDirection === 'SHORT') {
            console.log('Decision: Go SHORT.');
        } else {
            console.log('Decision: Stay in cash or wait for a clearer signal.');
        }

        return tradeDirection;
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

const fetchTradeHistory = async (symbol, orderId) => {
    try {
        const timestamp = await getBinanceServerTime();
        const recvWindow = 10000; // 10 seconds

        // Fetch all trades for the symbol
        const tradeHistory = await binance.futuresUserTrades(symbol);

        if (tradeHistory.code) {
            console.error(`Error fetching trade history: ${tradeHistory.msg}`);
            return null;
        }

        // Find the trade with the specified orderId
        const specificTrade = tradeHistory.find(trade => trade.orderId === orderId);

        if (!specificTrade) {
            console.log(`No trade found with orderId: ${orderId}`);
            return null;
        }

        return specificTrade;
    } catch (error) {
        console.error('Error fetching trade history:', error);
        return null;
    }
};

async function getBinanceServerTime() {
    try {
        const serverTime = await binance.futuresTime();
        return serverTime?.serverTime;
    } catch (error) {
        console.error('Error fetching Binance server time:', error);
        throw error;
    }
}



let previousCapital
let previousDirection
let previousBalance = math.bignumber(0);
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

            // Check if the response contains an error code
            if (response.code) {
                throw new Error(`API Error: ${response.msg} (Code: ${response.code})`);
            }

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
        // const currentDrawdown = math.subtract(1, math.divide(capital, highWaterMark));
        // if (math.larger(currentDrawdown, 0.05)) {
        //     positionSize = math.multiply(positionSize, math.bignumber(0.75)); // Reduce size if drawdown > 5%
        // }
    
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


    const monitorOpenPositions = async () => {
        try {
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

            for (const position of activePositions) {
                console.log(`Monitoring active position for ${position.symbol}...`);

                let positionClosed = false;
                let trailingStopPrice = null; // Initialize trailing stop price

                while (!positionClosed) {
                    // Fetch current market direction
                    const currentTradeDirection = await decideTradeDirection(positionClosed);
                    const markPrice = await fetchMarkPrice(); // Example current price

                    // Fetch updated positions and balance with correct timestamp and recvWindow
                    const [updatedPositions, balance] = await Promise.all([
                        binance.futuresPositionRisk({ symbol: position.symbol, timestamp, recvWindow }),
                        binance.futuresBalance({ timestamp, recvWindow })
                    ]);

                    if (updatedPositions.code) {
                        console.error(`Error fetching positions risk: ${updatedPositions.msg}`);
                        continue;
                    }

                    const currentPosition = updatedPositions.find(pos => parseFloat(pos.positionAmt) !== 0);

                    if (!currentPosition) {
                        // Position is closed
                        positionClosed = true;
                        sound.play("/Users/_bran/Documents/Trading/coin-flip-88793.mp3");

                        // Fetch trade history for the closed position
                        const tradeHistory = await fetchTradeHistory(symbol, position.orderId);

                        if (tradeHistory && tradeHistory.length > 0) {
                            // Calculate total PnL, fees, and other metrics
                            let totalPnL = 0;
                            let totalFees = 0;
                            let totalQuantity = 0;
                            let totalCost = 0;

                            tradeHistory.forEach(trade => {
                                totalPnL += parseFloat(trade.realizedPnl);
                                totalFees += parseFloat(trade.commission);
                                totalQuantity += parseFloat(trade.qty);
                                totalCost += parseFloat(trade.qty) * parseFloat(trade.price);
                            });

                            const avgEntryPrice = totalCost / totalQuantity;

                            // Update capital
                            const newCapital = parseFloat(balance.find(asset => asset.asset === 'USDT').balance);
                            capital = newCapital;

                            // Determine if the trade was a win or loss
                            const isWin = totalPnL > 0;

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

                            // Log trade details
                            trades.push({
                                index: totalTrades,
                                side: currentTradeDirection?.toLowerCase(),
                                symbol: symbol,
                                leverage: `x${leverage}`,
                                balance: `$ ${math.number(previousCapital).toFixed(2)} → $ ${math.number(capital).toFixed(2)}`,
                                balanceChange: `$ ${math.number(previousCapital).toFixed(2)} → $ ${math.number(capital).toFixed(2)} (${math.larger(capital, previousCapital) ? '+' : ''}${(math.number(math.subtract(capital, previousCapital)) / math.number(previousCapital) * 100).toFixed(2)}%)`,
                                fees: `$ ${math.number(totalFees).toFixed(3)}`,
                                rawPnl: math.number(totalPnL).toFixed(4),
                                tradeSize: math.number(totalQuantity),
                                entryPrice: math.number(avgEntryPrice).toFixed(7),
                                avgClosePrice: math.number(markPrice).toFixed(7),
                                markPrice: math.number(markPrice),
                                liqPrice: math.number(markPrice * (1 - (1 / leverage))).toFixed(4),
                                exposedAmount: `$ ${math.number(totalCost).toFixed(2)} (${(math.number(totalQuantity) * 100).toFixed(2)}% balance $ ${math.number(previousCapital).toFixed(2)})`,
                            });

                            console.log(chalkTable(tableOptions, trades));
                        } else {
                            console.error('No trade history found for the closed position.');
                        }

                        return true; // Keep trading
                    }

                    // Determine the position's direction (long or short)
                    const positionDirection = parseFloat(currentPosition.positionAmt) > 0 ? 'long' : 'short';

                    // Determine action and calculate prices
                    const isShort = positionDirection?.toLowerCase() === 'short';

                    // Opposite action: SELL for long, BUY for short
                    const oppositeAction = isShort ? 'BUY' : 'SELL';

                    // Calculate trailing stop price
                    const trailingStopDistance = 0.01; // 1% trailing stop distance (adjust as needed)
                    const newTrailingStopPrice = isShort
                        ? markPrice * (1 + trailingStopDistance) // For short positions, trail above the mark price
                        : markPrice * (1 - trailingStopDistance); // For long positions, trail below the mark price
                    // const tickSize = await fetchTickSize(symbol);
                    const { tickSize, lotSize } = await fetchSymbolPrecision(symbol);

                    const roundPrice = (price) => roundToPrecision(price, tickSize);
                    const roundQuantity = (quantity) => roundToPrecision(quantity, lotSize);

                    // Update trailing stop price if the market moves in a favorable direction
                    // if (!trailingStopPrice || (isShort && newTrailingStopPrice < trailingStopPrice) || (!isShort && newTrailingStopPrice > trailingStopPrice)) {
                    //     trailingStopPrice = newTrailingStopPrice;

                    //     // Cancel the existing stop-loss order
                    //     var cancelRes = await binance.futuresCancel(symbol,{ orderId: currentPosition.stopLossOrderId });



                    //     // / Round price and quantity to the correct precision


                    //     // Place a new stop-loss order with the updated trailing stop price
                    //     const stopLossOrder = {
                    //         symbol,
                    //         side: oppositeAction,
                    //         type: "STOP_MARKET",
                    //         quantity: roundQuantity(math.number(math.abs(parseFloat(currentPosition.positionAmt)))).toString(),
                    //         stopPrice: roundPrice(trailingStopPrice).toString(),
                    //     };

                    //     const [stopLossResponse] = await binance.futuresMultipleOrders([stopLossOrder]);

                    //     if (stopLossResponse.code) {
                    //         console.error(`Error updating stop-loss order: ${stopLossResponse.msg}`);
                    //     } else {
                    //         console.log(`Stop-loss order updated successfully:`, {
                    //             orderId: stopLossResponse.orderId,
                    //             symbol: stopLossResponse.symbol,
                    //             stopPrice: stopLossResponse.stopPrice,
                    //         });
                    //     }
                    // }

                    // Log if market direction changes
                    // if (currentTradeDirection && positionDirection?.toLowerCase() !== currentTradeDirection?.toLowerCase()) {
                    //     console.log(`Market direction changed from ${positionDirection.toUpperCase()} to ${currentTradeDirection}.`);
                    //     sound.play("/Users/_bran/Documents/Trading/e-piano-key-note-f_95bpm_F_minor.wav");

                    //     // Prepare orders to close the position
                    //     const closeOrders = [
                    //         {
                    //             symbol,
                    //             side: oppositeAction, // Opposite of the current position's direction
                    //             type: "MARKET",
                    //             quantity: roundQuantity(math.number(math.abs(parseFloat(currentPosition.positionAmt)))).toString(), // Use the absolute value of positionAmt
                    //         },
                    //     ];

                    //     // Execute the close orders
                    //     const closeResponse = await binance.futuresMultipleOrders(closeOrders);

                    //     let allCloseOrdersSuccessful = true;

                    //     closeResponse.forEach((order, index) => {
                    //         if (order.code) {
                    //             // Handle failed orders
                    //             console.error(`Error in closing order ${index + 1}: ${order.msg}`);
                    //             allCloseOrdersSuccessful = false; // Flag error
                    //         } else {
                    //             // Handle successful orders
                    //             console.log(`Closing order ${index + 1} placed successfully:`, {
                    //                 orderId: order.orderId,
                    //                 symbol: order.symbol,
                    //                 status: order.status,
                    //                 side: order.side,
                    //                 type: order.type,
                    //                 quantity: order.origQty,
                    //                 price: order.price,
                    //                 time: new Date(order.updateTime).toLocaleString(),
                    //             });
                    //         }
                    //     });

                    //     if (allCloseOrdersSuccessful) {
                    //         sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
                    //         console.log("Position closed successfully.");
                    //         positionClosed = true; // Set positionClosed to true to exit the loop
                    //         return true; // Signal that the position is closed
                    //     } else {
                    //         console.error("Failed to close the position.");
                    //     }
                    // }

                    // Update previous direction
                    previousDirection = currentTradeDirection;

                    // Wait before checking again
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            return false; // No position was closed
        } catch (error) {
            console.error('Error monitoring positions:', error);
            return false; // Signal an error
        }
    };


    const executeTrade = async () => {
        try {
            // Fetch Binance server time
            const timestamp = await getBinanceServerTime();
            const recvWindow = 10000; // 10 seconds

            // Check if there are any open positions on Binance
            const openPositions = await binance.futuresPositionRisk({ symbol: symbol, timestamp, recvWindow });
            const markPrice = await fetchMarkPrice(); // Example current price

            if (openPositions.code) {
                console.error(`Error fetching positions: ${openPositions.msg}`);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying
                return false; // Skip this iteration and retry
            }

            // Filter active positions with non-zero quantity
            const activePositions = openPositions.filter(pos => parseFloat(pos.positionAmt) !== 0);

            if (activePositions.length > 0) {
                // Monitor the existing position
                console.log('An open position already exists. Monitoring the position...');
                await monitorOpenPositions();
                console.log('Position monitoring completed. Checking for new trading opportunities...');
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
            let tpPrice, slPrice;

            // Set markPrice and calculate TP and SL based on the trade direction
            const desiredWinPnL = 1.00; // 100% profit on capital
            const desiredLossPnL = 1.00; // 100% loss on capital
            const ATRMultiplier = 0.3; // Multiplier for ATR-based SL (adjust based on risk tolerance)

            const [{ input: input1m }, { input: input3m }] = await Promise.all([
                fetchOHLCVWithRetry(exchange, symbol, '1m'), // 1-minute data with retry
                fetchOHLCVWithRetry(exchange, symbol, '3m')  // 3-minute data with retry
            ]);

            const [atr1m] = await Promise.all([
                atr(5, input1m), // 1-minute ATR
            ]);

            // Fetch the latest ATR value (from 1-minute or 3-minute timeframe)
            const atrValue = atr1m[atr1m.length - 1]; // Use the latest 1-minute ATR value

            if (goLong) {
                tpPrice = markPrice * (1 + (desiredWinPnL / leverage)); // TP for long (25% win)
                slPrice = markPrice * (1 - (desiredLossPnL / leverage)); // SL for long (10% loss)
            } else {
                tpPrice = markPrice * (1 - (desiredWinPnL / leverage)); // TP for short (25% win)
                slPrice = markPrice * (1 + (desiredLossPnL / leverage)); // SL for short (10% loss)
            }

            // Optional: Use ATR-based SL as an alternative or additional condition
            // if (goLong) {
            //     slPrice = Math.min(slPrice, markPrice - (atrValue * ATRMultiplier)); // Use the tighter SL
            // } else {
            //     slPrice = Math.max(slPrice, markPrice + (atrValue * ATRMultiplier)); // Use the tighter SL
            // }

            console.log(`Trade Direction: ${goLong ? 'LONG' : 'SHORT'}`);
            console.log(`Entry Price: ${markPrice}`);
            console.log(`Take Profit: ${tpPrice}`);
            console.log(`Stop Loss: ${slPrice}`);
            console.log(`ATR Value: ${atrValue}`);

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
                { sym?bol, side: oppositeAction, type: "STOP_MARKET", quantity: roundQuantity(math.number(notionalSize)).toString(), stopPrice: roundPrice(slPrice).toString() }
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

            // await new Promise(resolve => setTimeout(resolve, 2000));

            // Monitor the position until it's closed
            let positionClosed = false;
            while (!positionClosed) {
                positionClosed = await monitorOpenPositions();
                if (!positionClosed) {
                    console.error(`Position has been closed, no onger monitoring`);
                    // await new Promise(resolve => setTimeout(resolve, 1000));
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
    const cooldownDuration = .1 * 60 * 1000; // 1 minute in milliseconds

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

// Total PnL and Fees
let totalPnL = math.bignumber(0);
let totalFeesCombined = math.bignumber(0);


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
const innitialStartingCapital = 1; // Initial capital in USDT
const targetGoal = math.bignumber(10.00); // Final goal in USDT

runSimulationInStages(innitialStartingCapital, targetGoal, winrate, leverage);
