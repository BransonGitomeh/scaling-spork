let {
  adx: adxGet,
  atr,
  bb,
  cci,
  ema,
  ichimokuCloud,
  macd,
  mfi,
  obv,
  rsi,
  sma,
  stochasticRSI,
  vwap,
  wma,
  kst,
  getDetachSourceFromOHLCV,
} = require("trading-indicator");
let fs = require("fs");
let chalk = require("chalk");
let moment = require("moment");
require("dotenv").config();
let chalkTable = require("chalk-table");
let Binance = require("node-binance-api");
let sound = require("sound-play");
const math = require("mathjs");
const mathjs = require("mathjs");
const { readFile } = require('fs/promises');

let { BINANCE_API_KEY, BINANCE_SECRET_KEY } = process.env;
let binance = new Binance().options({
  APIKEY: BINANCE_API_KEY,
  APISECRET: BINANCE_SECRET_KEY,
  family: 4,
  // test: true, // Add this to enable test mode
});

let exchange = "binance";
let market = "DEGOUSDT";
let symbol = "DEGOUSDT";
let intervals = ["1m", "5m"];
let getFutureMarket = true;

let lastActionTime = 0;
let longPosition = false;
let shortPosition = false;

let SESSION_DIR = "./sessions";

let session = { orders: [] };

const humanizeDuration = require("humanize-duration");

let adxThreshold = 25;
let dailyLoss = 0;
let maxDailyLoss = 0.4;
let maxDrawdown = 0.5;
let profitThreshold = 0.3;
let stopLossThreshold = 0.05;
let trendChangeConfirmationThreshold = 4;
const pnlPercentageThreshold = 10;
const pnlPercentageLossThreshold = -30; // Changed from 30 to -30 to reflect the correct threshold for losses

let sessionPath = `${SESSION_DIR}/session.json`;

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR);
}

let activeOrder;

let saveSession = () => {
  try {
    // session.orders = orders;  // save the orders array
    session.longPosition = longPosition;
    session.shortPosition = shortPosition;
    fs.writeFileSync(
      `${SESSION_DIR}/session.json`,
      JSON.stringify(session, null, 2),
    );
  } catch (err) {
    console.error(chalk.red(`Error saving session: ${err.message}`));
  }
};

let analyzeVolume = (aggTrades = []) => {
  let volumeData = aggTrades.map((t) => parseFloat(t.q));
  let avgVolume = volumeData.reduce((sum, v) => sum + v, 0) / volumeData.length;
  let currentVolume = parseFloat(aggTrades[aggTrades.length - 1]?.q);

  let volumeSignal = "Volume is stable.";
  if (currentVolume > avgVolume * 1.5) {
    volumeSignal = chalk.yellow(
      `Volume spike: ${currentVolume} > ${avgVolume} * 1.5`,
    );
  } else if (currentVolume < avgVolume * 0.8) {
    volumeSignal = chalk.red(
      `Volume drop: ${currentVolume} < ${avgVolume} * 0.8`,
    );
  } else if (currentVolume > avgVolume * 1.2) {
    volumeSignal = chalk.yellow(
      `Moderate volume increase: ${currentVolume} > ${avgVolume} * 1.2`,
    );
  } else if (currentVolume < avgVolume * 1.1) {
    volumeSignal = chalk.red(
      `Moderate volume decrease: ${currentVolume} < ${avgVolume} * 1.1`,
    );
  }

  return volumeSignal;
};

let analyzeSpread = (orderBook = { bids: [], asks: [] }) => {
  let bids = orderBook.bids;
  let asks = orderBook.asks;

  let top10BidPrices = bids.slice(0, 10).map(([price]) => parseFloat(price));
  let top10AskPrices = asks.slice(0, 10).map(([price]) => parseFloat(price));

  let averageBidPrice =
    top10BidPrices.reduce((sum, price) => sum + price, 0) /
    top10BidPrices.length;
  let averageAskPrice =
    top10AskPrices.reduce((sum, price) => sum + price, 0) /
    top10AskPrices.length;
  let spread = averageAskPrice - averageBidPrice;
  let averageSpread = 0.01; // Set a threshold for average spread

  let spreadSignal = "Spread is stable.";
  if (spread > averageSpread * 1.5) {
    spreadSignal = chalk.yellow(
      `Spread widening: ${spread} > ${averageSpread} * 1.5`,
    );
  } else if (spread < averageSpread * 0.5) {
    spreadSignal = chalk.red(
      `Spread tightening: ${spread} < ${averageSpread} * 0.5`,
    );
  } else if (spread > averageSpread * 1.2) {
    spreadSignal = chalk.yellow(
      `Moderate spread widening: ${spread} > ${averageSpread} * 1.2`,
    );
  } else if (spread < averageSpread * 1.1) {
    spreadSignal = chalk.red(
      `Moderate spread tightening: ${spread} < ${averageSpread} * 1.1`,
    );
  }

  return spreadSignal;
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

  let aggTrades = [];
  let recentTrades = [];
  let historicalTrades = [];
  let orderBook = {
    bids: [],
    asks: [],
  };

  try {
    let aggTradesResp = await binance.futuresAggTrades(symbol);
    aggTrades = aggTradesResp.code ? [] : aggTradesResp;

    let recentTradesResp = await binance.futuresTrades(symbol);
    recentTrades = recentTradesResp || [];

    let historicalTradesResp = await binance.futuresHistoricalTrades(symbol);
    historicalTrades = historicalTradesResp || [];

    orderBook = await binance.futuresDepth(symbol, { limit: 10 });

    // Cache the successful response
    cache.data = { aggTrades, recentTrades, historicalTrades, orderBook };
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

  return { aggTrades, recentTrades, historicalTrades, orderBook };
};

// Helper function: Calculate moving average
const calculateMovingAverage = (buffer, key) => {
  if (buffer.length === 0) return 0;
  return buffer.reduce((sum, data) => sum + data[key], 0) / buffer.length;
};

// Trading parameters
let performanceMetrics = {
  profitLoss: 0, // Total profit/loss across all trades
  numTrades: 0, // Total number of trades
  winRate: 0, // Percentage of winning trades
  averageWin: 0, // Average profit per winning trade
  averageLoss: 0, // Average loss per losing trade
  maxDrawdown: 0, // Maximum drawdown observed
  currentDrawdown: 0, // Current drawdown
  longestWinStreak: 0, // Longest consecutive winning streak
  longestLossStreak: 0, // Longest consecutive losing streak
  sharpeRatio: 0, // Sharpe Ratio (risk-adjusted return)
  sortinoRatio: 0, // Sortino Ratio (downside risk-adjusted return)
  drawdown: 0, // Current cumulative drawdown
  totalWins: 0, // Total number of winning trades
  totalLosses: 0, // Total number of losing trades
  totalWinAmount: 0, // Total profit from winning trades
  totalLossAmount: 0, // Total loss from losing trades
  riskRewardRatio: 0, // Average risk-reward ratio
  profitFactor: 0, // Total profit divided by total loss
  consistencyScore: 0, // Ratio of longest win streak to longest loss streak
};

let invested = 1;
let leverage = 100;
let targetPnl = 100

function updateOrder(order, markPrice) {
  order.exitTime = Date.now();
  order.exitPrice = markPrice;

  const index = session.orders.findIndex((o) => o?.id === order?.id);
  // Update the order on session.orders
  if (index !== -1) {
    session.orders[index] = order;
  }
}

let liveMode = false;

function calculateSize(invested, price, precision) {
  let size = invested / price;
  return math.round(size * math.pow(10, precision)) / math.pow(10, precision);
}

async function executeWithRetries(fn, maxRetries = 5, delay = 1000) {
  let attempts = 0;
  let lastError = null;

  while (attempts < maxRetries) {
    try {
      const response = await fn();
      // Check if the response has a valid .code
      if (response.code === undefined || response.code === 0) {
        return response; // Success
      } else {
        console.error(
          `Attempt ${attempts + 1}: Error code ${response.code} - ${response.msg}`,
        );
      }
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempts + 1}: ${error.message}`);
    }

    attempts++;
    if (attempts < maxRetries) {
      console.log(`Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay)); // Wait before retry
    }
  }

  throw new Error(
    `Failed after ${maxRetries} attempts. Last error: ${lastError?.message || "Unknown error"}`,
  );
}

async function closePositionOld(price, orderBookAnalysis,
  absoluteVolumeDifference,
  volumeVelocity,
  velocityThreshold) {
  const order = activeOrder;
  if (!order) {
    return;
  }

  activeOrder.exitTimestamp = Date.now();
  activeOrder.exitPrice = price;
  Object.assign(activeOrder, {
    closeSummary: {
      absoluteVolumeDifference,
      volumeVelocity,
      velocityThreshold,
      sellVolume: orderBookAnalysis.volumes.sellVolume,
      buyVolume: orderBookAnalysis.volumes.buyVolume
    }
  })

  try {
    if (liveMode) {
      // Place market order at best entry price
      let orderResponse;
      if (side === "long") {
        orderResponse = await executeWithRetries(() =>
          binance.futuresMarketBuy(symbol, size),
        );
      } else {
        orderResponse = await executeWithRetries(() =>
          binance.futuresMarketSell(symbol, size),
        );
      }

      // Set leverage
      await executeWithRetries(() => binance.futuresLeverage(symbol, leverage));

      // Exit Position at this price
      let limitOrderResponse;
      const exitSize = math.round(math.divide(invested, favorableExitPrice), 0); // Precision set to 0
      if (side === "long") {
        limitOrderResponse = await executeWithRetries(() =>
          binance.futuresSell(symbol, size, favorableExitPrice),
        );
      } else {
        limitOrderResponse = await executeWithRetries(() =>
          binance.futuresBuy(symbol, size, favorableExitPrice),
        );
      }

      // Log responses
      console.log("Market order placed:", orderResponse);
      console.log("Limit order placed:", limitOrderResponse);

      if (orderResponse.code === 0) {
        // session.orders.push(order);
        // activeOrder = undefined;
        console.log(`Order created: ${order?.id}`);
        sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
      } else {
        console.error(`Error creating order: ${orderResponse.msg}`);
      }
    } else {
      console.log("Simulation mode: skipping Binance API call");
      // session.orders.push(order);
      // activeOrder = undefined;
      console.log(`Order created: ${order?.id}`);
      sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
    }

    saveSession();
  } catch (error) {
    console.error(`Failed to execute order: ${error.message}`);
  }
}


async function closePosition(price) {
  if (!activeOrder || !price) {
    console.error("Invalid order or price. Cannot close position.");
    return;
  }

  const { id, side, positionAmt, size: orderSize, entryPrice: orderEntryPrice } = activeOrder;
  activeOrder.exitTimestamp = Date.now();
  activeOrder.exitPrice = price;

  const size = parseFloat(positionAmt || orderSize);
  const entryPrice = parseFloat(orderEntryPrice);
  const exitPrice = parseFloat(price);

  // Calculate PnL
  const pnl = side === "long"
    ? (exitPrice - entryPrice) * size  // For long positions, profit when price goes up
    : Math.abs((entryPrice - exitPrice) * size); // For short positions, use absolute value to ensure positive PnL when profitable


  try {
    if (liveMode) {
      const marketOrderFn = side === "long"
        ? () => binance.futuresMarketSell(symbol, size)
        : () => binance.futuresMarketBuy(symbol, size);

      const orderResponse = await executeWithRetries(marketOrderFn);
      console.log("Market order placed:", orderResponse);

      // Update capital with PnL
      invested = math.add(invested, pnl);
      console.log(`P&L: ${pnl.toFixed(2)} USD`);
      console.log(`Updated invested capital: ${invested.toFixed(2)} USD`);
    } else {
      console.log("Simulation mode: Skipping API calls");
      invested = math.add(invested, pnl);
      console.log(`P&L: ${pnl.toFixed(2)} USD`);
      console.log(`Updated invested capital: ${invested.toFixed(2)} USD`);
    }

    // Play appropriate sound based on profit or loss
    const soundPath = pnl >= 0
      ? "/Users/_bran/Documents/Trading/coin-clatter-6-87110.mp3"
      : "/Users/_bran/Documents/Trading/bubble-pop-high-jam-fx-1-00-00.mp3";

    sound.play(soundPath);

    // Find and update the order in session.orders
    const existingOrder = session.orders.find((order) => order?.id === activeOrder?.id);
    if (existingOrder) {
      Object.assign(existingOrder, activeOrder);
      console.log(`Order with ID ${id} updated successfully in session.`);
    } else {
      console.warn(`Order with ID ${id} not found in session.orders.`);
    }

    saveSession();
  } catch (error) {
    console.error(`Failed to close position: ${error.message}`);
  }
}

const riskPerTrade = 0.02; // Risk 2% of capital per trade

function getOptimalEntryPrice(side, buyWalls, sellWalls, currentPrice, leverage, invested) {
  const targetOrders = side === "long" ? buyWalls : sellWalls;
  if (!targetOrders || targetOrders.length === 0) {
    return currentPrice; // No target orders found, use current price
  }

  // Sort orders by volume (descending)
  const sortedOrders = [...targetOrders].sort((a, b) => parseFloat(b.q) - parseFloat(a.q));

  // Select top N orders (e.g., top 5) with sufficient volume
  const topN = 5;
  const topOrders = sortedOrders.slice(0, topN);

  // Calculate weighted average price of top orders
  let totalVolume = 0;
  let weightedPriceSum = 0;
  for (const order of topOrders) {
    totalVolume += parseFloat(order.q);
    weightedPriceSum += parseFloat(order.p) * parseFloat(order.q);
  }
  const weightedAveragePrice = totalVolume > 0 ? weightedPriceSum / totalVolume : currentPrice;

  // Calculate target profit based on leverage
  const targetProfit = 0.1; // 20% profit target

  // Calculate the price that would result in the target profit
  const targetPrice = side === "long"
    ? currentPrice * (1 + (targetProfit / leverage))
    : currentPrice * (1 - (targetProfit / leverage));

  // Find the closest order in the order book to the target price
  let closestOrderPrice;
  for (const order of targetOrders) {
    const orderPrice = parseFloat(order.p);
    if (side === "long" && orderPrice >= targetPrice) {
      closestOrderPrice = orderPrice;
      break;
    } else if (side === "short" && orderPrice <= targetPrice) {
      closestOrderPrice = orderPrice;
      break;
    }
  }

  // If no suitable order is found, return null
  if (!closestOrderPrice) {
    return null;
  }

  // Add a small buffer to the closest order price
  const priceBuffer = 0.0001; // Adjust buffer size based on market volatility
  return side === "long"
    ? closestOrderPrice + priceBuffer
    : closestOrderPrice - priceBuffer;
}

function groupOrdersByPrice(orders) {
  const groupedOrders = {};

  for (const order of orders) {
    const price = parseFloat(order.p).toFixed(7); // Ensures price precision up to 7 decimals
    const quantity = parseFloat(order.q); // Convert quantity to a float

    // Aggregate quantity for each price level
    if (groupedOrders[price]) {
      groupedOrders[price] += quantity;
    } else {
      groupedOrders[price] = quantity;
    }
  }

  return groupedOrders;
}

// async function createPositionOld(
//   side,
//   currentPrice,
//   orderBookAnalysis,
//   signals,
//   smoothedImbalance,
//   absoluteVolumeDifference,
//   volumeVelocity,
//   velocityThreshold
// ) {
//   // Extract ATR and supporting signals
//   const ATR = signals["1m"]?.supportingData?.ATR || 0.0005; // Default ATR fallback
//   const leverage = calculateDynamicLeverage(ATR, 10); // Step 1: Dynamic Leverage

//   console.log(`Dynamic Leverage Applied: ${leverage}x (ATR: ${ATR.toFixed(6)})`);

//   // Extract VWAP from signals or compute it dynamically
//   const VWAP = signals["1m"]?.supportingData?.VWAP || orderBookAnalysis.vwap || 0;

//   console.log(`VWAP: ${VWAP.toFixed(8)}`);

//   // Confirm trade entry using VWAP
//   if ((side === "long" && currentPrice > VWAP) || (side === "short" && currentPrice < VWAP)) {
//     console.warn("Trade skipped: Current price is not favorable relative to VWAP.");
//     return undefined; // Skip trade if price isn't favorable
//   }

//   // Step 2: Calculate Position Size with Imbalance Adjustment
//   function calculatePositionSize(capital, price, leverage, imbalance) {
//     const baseSize = Math.max(1, Math.floor((capital * leverage) / price)); // Minimum size is 1
//     const imbalanceFactor = Math.max(0.5, Math.min(2, 1 + smoothedImbalance)); // Scale position size by imbalance
//     return Math.ceil(baseSize * imbalanceFactor);
//   }

//   let positionSize = calculatePositionSize(invested, currentPrice, leverage, smoothedImbalance);

//   console.log(`Position Size (Adjusted by Imbalance): ${positionSize}`);

//   // Step 3: Ensure Minimum Notional
//   const minNotional = 5.1;
//   const notional = positionSize * currentPrice;
//   if (notional < minNotional) {
//     console.warn(`Notional (${notional}) is less than ${minNotional}. Adjusting position size.`);
//     positionSize = Math.ceil(minNotional / currentPrice);
//   }

//   // Step 4: Calculate Stop-Loss and Take-Profit
//   const { stopLoss, takeProfit } = calculateStopLossAndTakeProfit(
//     side,
//     currentPrice,
//     leverage,
//     2, // Risk-Reward Ratio
//     ATR // Use ATR for volatility-based calculation
//   );

//   console.log(`Stop Loss: ${stopLoss}, Take Profit: ${takeProfit}`);

//   // Step 5: Round Prices and Quantities
//   const roundedStopLoss = stopLoss.toFixed(4);
//   const roundedTakeProfit = takeProfit.toFixed(4);
//   const roundedPositionSize = positionSize.toFixed(4);

//   console.log("Final Trade Parameters:", {
//     leverage,
//     positionSize: roundedPositionSize,
//     stopLoss: roundedStopLoss,
//     takeProfit: roundedTakeProfit,
//     VWAP: VWAP.toFixed(8),
//     smoothedImbalance,
//   });

//   const simulatedOrderDetails = {
//     id: generateUUID(),
//     side: side,
//     symbol: market,
//     positionAmt: roundedPositionSize,
//     leverage: leverage,
//     entryTimestamp: Date.now(),
//     entryPrice: currentPrice,
//     stopLoss,
//     takeProfit,
//     margin: ((positionSize * currentPrice) / leverage).toFixed(8),
//     VWAP,
//     smoothedImbalance,
//     status: "Simulated",
//     timestamp: Date.now(),
//     absoluteVolumeDifference,
//     volumeVelocity,
//     velocityThreshold,
//     sellVolume: orderBookAnalysis.volumes.sellVolume,
//     buyVolume: orderBookAnalysis.volumes.buyVolume
//   };

//   // Order Placement Logic (Simulated or Live)
//   try {
//     if (liveMode) {
//       await binance.futuresLeverage(market, leverage); // Dynamically apply leverage
//       const orders = [
//         {
//           symbol: market,
//           side: side === "long" ? "BUY" : "SELL",
//           type: "MARKET",
//           quantity: roundedPositionSize,
//         },
//         {
//           symbol: market,
//           side: side === "long" ? "SELL" : "BUY",
//           type: "LIMIT",
//           price: roundedTakeProfit,
//           quantity: roundedPositionSize,
//           timeInForce: "GTC",
//         },
//         {
//           symbol: market,
//           side: side === "long" ? "SELL" : "BUY",
//           type: "STOP_MARKET",
//           stopPrice: roundedStopLoss,
//           quantity: roundedPositionSize,
//         },
//       ];

//       const response = await binance.futuresMultipleOrders(orders);
//       console.log("Orders successfully placed:", response);
//       session.orders.push(simulatedOrderDetails);
//       activeOrder = simulatedOrderDetails;
//       sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
//       return simulatedOrderDetails;
//     } else {
//       console.log("Simulation Mode: Order Details:", simulatedOrderDetails);
//       session.orders.push(simulatedOrderDetails);
//       saveSession();
//       sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3");
//       return simulatedOrderDetails;
//     }
//   } catch (error) {
//     console.error("Order Error:", error.message);
//   }
// }

function calculateDynamicLeverage(ATR, maxLeverage = 100, adx = 20) {
  // Normalize ATR: Low ATR (low volatility) => High leverage; High ATR (high volatility) => Low leverage
  const atrLeverageFactor = Math.max(0.1, 1 - (ATR / 0.01)); // ATR normalization factor (example: ATR > 0.01 lowers leverage)

  // Normalize ADX: High ADX (strong trend) => Increase leverage; Low ADX (weak trend) => Decrease leverage
  const adxLeverageFactor = Math.min(1, adx / 25); // ADX normalization (example: ADX > 25 gives max leverage boost)

  // Calculate final dynamic leverage
  let dynamicLeverage = maxLeverage * atrLeverageFactor * adxLeverageFactor;

  // Ensure leverage is between 1 and maxLeverage (100)
  dynamicLeverage = Math.min(Math.max(1, dynamicLeverage), maxLeverage);

  return dynamicLeverage;
}


async function createPosition(
  side,
  currentPrice,
  orderBookAnalysis,
  signals,
  smoothedImbalance,
  trendIndicators // Object containing smaShort, smaLong, emaShort, emaLong
) {
  const initialPositionSize = invested; // Starting position size
  const minNotional = 5.1; // Minimum notional for trade
  let currentBalance = invested; // Track balance dynamically

  // Function to calculate position size with Martingale logic
  function calculateMartingalePositionSize(lastOrder, sessionOrders) {
    const baseSize = initialPositionSize; // Base position size (e.g., 2 units)
    const sessionPnL = calculateSessionPnL(sessionOrders); // Total PnL for the session
    // const leverage = 100; // Example leverage (100x)
  
    let newSize = baseSize;
  
    if (lastOrder) {
      const lastPnL = calculatePnL(lastOrder); // Calculate PnL of the last order
  
      if (lastPnL < 0) {
        // Double position size after a loss, but ensure it doesn't exceed max available balance
        newSize = Math.min(lastOrder.positionAmt * 2, currentBalance / currentPrice);
      } else if (sessionPnL > 0) {
        // Reset to base size or reduce after a win
        newSize = Math.max(baseSize, lastOrder.positionAmt / 2);
      }
    }
  
    // Ensure new position size doesn't exceed available balance
    const maxSizeByBalance = currentBalance / currentPrice; // Maximum position size by balance
    newSize = Math.min(newSize, maxSizeByBalance);
  
    // Now, apply leverage to calculate margin required for the new position size
    const notional = newSize * currentPrice; // Notional is position size * entry price
    const marginRequired = notional / leverage; // Margin required with leverage
  
    return { newSize, marginRequired }; // Returning both the new position size and required margin
  }
  

  // Helper function to calculate PnL for a given order
  function calculatePnL(order) {
    // Formula: (Exit Price - Entry Price) * Position Amount for LONG
    //          (Entry Price - Exit Price) * Position Amount for SHORT
    const directionMultiplier = order.side === "LONG" ? 1 : -1;
    return (order.exitPrice - order.entryPrice) * order.positionAmt * directionMultiplier;
  }

  // Helper function to calculate total session PnL
  function calculateSessionPnL(sessionOrders) {
    return sessionOrders.reduce((total, order) => total + calculatePnL(order), 0);
  }

  // Get the last order and calculate position size
  const sessionOrders = session.orders || [];
  const lastOrder = sessionOrders[sessionOrders.length - 1];
  let positionSize = calculateMartingalePositionSize(lastOrder, sessionOrders);

  console.log(`Position Size (Martingale Adjusted): ${positionSize}`);

  // Step 3: Ensure Minimum Notional
  const notional = positionSize * currentPrice;
  if (notional < minNotional) {
    console.warn(`Notional (${notional}) is less than ${minNotional}. Adjusting position size.`);
    positionSize = Math.ceil(minNotional / currentPrice);
  }

  // Step 4: Calculate Stop-Loss and Take-Profit
  const ATR = signals["1m"]?.supportingData?.ATR || 0.0005; // Default ATR fallback
  const { stopLoss, takeProfit } = calculateDynamicStopLossAndTakeProfit(
    side,
    currentPrice,
    leverage,
    positionSize,
    targetPnl,
    100
  );

  // Update balance for the next trade
  currentBalance -= positionSize * currentPrice / leverage;

  console.log(`Stop Loss: ${stopLoss}, Take Profit: ${takeProfit}`);
  console.log("Final Trade Parameters:", {
    positionSize: positionSize.toFixed(4),
    stopLoss: stopLoss.toFixed(4),
    takeProfit: takeProfit.toFixed(4),
  });

  // Place simulated or live order
  const simulatedOrderDetails = {
    id: generateUUID(),
    side,
    symbol,
    positionAmt: positionSize.toFixed(4),
    entryPrice: currentPrice,
    stopLoss,
    leverage,
    takeProfit,
    entryTimestamp: Date.now(),
    margin: ((positionSize * currentPrice) / leverage).toFixed(8),
    VWAP: signals["1m"]?.supportingData?.VWAP || 0,
    smoothedImbalance,
    status: "Simulated",
    timestamp: Date.now(),
  };

  session.orders.push(simulatedOrderDetails);

  if (liveMode) {
    try {
      const orderResponse = await binance.futuresCreateOrder({
        symbol: market,
        side: side === "long" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: positionSize.toFixed(4),
      });

      simulatedOrderDetails.id = orderResponse.orderId;
      simulatedOrderDetails.status = "Live";
      console.log("Live Order Placed:", orderResponse);
      sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3")
    } catch (error) {
      console.error("Error Placing Order:", error);
    }
  } else {
    console.log("Simulated Order:", simulatedOrderDetails);
    sound.play("/Users/_bran/Documents/Trading/effect_notify-84408.mp3")
  }

  return simulatedOrderDetails;
}


function calculateDynamicStopLossAndTakeProfit(side, currentPrice, leverage, positionSize, pnlTargetPercent = 100, lossLimitPercent = 80) {
  // Convert inputs to bignumbers (if they aren't already)
  // const currentPriceBN = math.bignumber(currentPrice);
  // const leverageBN = math.bignumber(leverage);
  const positionSizeBN = math.bignumber(positionSize.newSize);
  // const pnlTargetPercentBN = math.bignumber(pnlTargetPercent);
  // const lossLimitPercentBN = math.bignumber(lossLimitPercent);

  // Calculate margin for the trade: margin = (positionSize * currentPrice) / leverage
  const margin = math.divide(math.multiply(positionSizeBN, currentPriceBN), leverageBN);

  // Calculate the distance for the take-profit: takeProfitDistance = (margin * pnlTargetPercent / 100) / positionSize
  const takeProfitDistance = math.divide(
    math.multiply(margin, math.divide(pnlTargetPercentBN, 100)),
    positionSizeBN
  );

  // Calculate the distance for the stop-loss: stopLossDistance = (margin * lossLimitPercent / 100) / positionSize
  const stopLossDistance = math.divide(
    math.multiply(margin, math.divide(lossLimitPercentBN, 100)),
    positionSizeBN
  );

  // Determine the stop-loss and take-profit levels based on direction
  const stopLoss = side === "long"
    ? math.subtract(currentPriceBN, stopLossDistance) // Long: Stop-loss below entry price
    : math.add(currentPriceBN, stopLossDistance); // Short: Stop-loss above entry price

  const takeProfit = side === "long"
    ? math.add(currentPriceBN, takeProfitDistance) // Long: Take-profit above entry price
    : math.subtract(currentPriceBN, takeProfitDistance); // Short: Take-profit below entry price

  return { stopLoss, takeProfit };
}





// Helper function to get price precision for a market
let pricePrecisionCache = {};

async function getPricePrecision(market) {
  if (pricePrecisionCache[market]) {
    return pricePrecisionCache[market];
  }

  const symbolInfo = await binance.futuresExchangeInfo(market);
  const marketSymbol = symbolInfo.symbols.find(
    ({ symbol }) => symbol === market,
  );
  if (!marketSymbol) {
    throw new Error(`Market not found: ${market}`);
  }
  const priceFilter = marketSymbol.filters.find(
    (filter) => filter.filterType === "PRICE_FILTER",
  );
  const tickSize = parseFloat(priceFilter.tickSize);
  const precision = math.log10(1 / tickSize);
  pricePrecisionCache[market] = precision;
  return precision;
}

function calculateMargin(markPrice, positionSize, leverage) {
  // calculate margin based on position size, leverage, and mark price
  // this is a simplified example, you may need to adjust the formula based on your exchange's margin calculation
  return (positionSize * markPrice) / leverage;
}

function generateUUID() {
  // generate a unique ID for the order
  // you can use a library like uuidv4 or create your own implementation
  return Math.floor(Math.random() * 1000000000).toString();
}

let previousState = {
  volumes: { buyVolume: 0, sellVolume: 0 },
  price: 0,
  walls: { buyWalls: [], sellWalls: [] },
};
const MAX_WALLS_TO_SHOW = 3; // Limit the number of entries shown

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

const analyzeOrderBook = (orderBook) => {
  const calculateVWAP = (orders) => {
    const totalVolume = orders.reduce(
      (sum, order) => sum + parseFloat(order.q),
      0,
    );
    const weightedPriceSum = orders.reduce(
      (sum, order) => sum + order.p * parseFloat(order.q),
      0,
    );
    return totalVolume > 0 ? weightedPriceSum / totalVolume : 0;
  };

  const detectPriceClusters = (orders, threshold) => {
    const priceBuckets = {};
    orders.forEach((order) => {
      const bucket = Math.round(order.p / threshold) * threshold;
      if (!priceBuckets[bucket]) priceBuckets[bucket] = 0;
      priceBuckets[bucket] += parseFloat(order.q);
    });
    return Object.entries(priceBuckets).sort((a, b) => b[1] - a[1]);
  };

  const detectPriceWalls = (orders, volumeThreshold) => {
    return orders.filter((order) => parseFloat(order.q) >= volumeThreshold);
  };

  // Split orders into buy and sell
  const buyOrders = orderBook.filter((order) => !order.m);
  const sellOrders = orderBook.filter((order) => order.m);

  const bestBid = Math.max(...buyOrders.map((order) => order.p));
  const bestAsk = Math.min(...sellOrders.map((order) => order.p));
  const midPrice = (bestBid + bestAsk) / 2;

  const vwap = calculateVWAP(orderBook);
  const buyVolume = buyOrders.reduce(
    (sum, order) => sum + parseFloat(order.q),
    0,
  );
  const sellVolume = sellOrders.reduce(
    (sum, order) => sum + parseFloat(order.q),
    0,
  );
  const imbalance = (buyVolume - sellVolume) / (buyVolume + sellVolume);

  const buyClusters = detectPriceClusters(buyOrders, 0.5);
  const sellClusters = detectPriceClusters(sellOrders, 0.5);

  const buyWalls = detectPriceWalls(buyOrders, 500);
  const sellWalls = detectPriceWalls(sellOrders, 500);

  let longWeight = Math.max(0, Math.tanh(imbalance * 5));
  let shortWeight = Math.max(0, -Math.tanh(imbalance * 5));

  if (buyClusters.length > 0) longWeight += buyClusters[0][1] / buyVolume;
  if (sellClusters.length > 0) shortWeight += sellClusters[0][1] / sellVolume;

  const bestLongExit = Math.min(...sellOrders.map((order) => order.p));
  const bestShortExit = Math.max(...buyOrders.map((order) => order.p));

  // Wall Exhaustion Analysis
  const wallExhaustion = {
    buy: buyWalls.map((wall, index) => {
      const prevWall = previousState.walls.buyWalls[index] || { q: 0 };
      return { ...wall, delta: wall.q - prevWall.q };
    }),
    sell: sellWalls.map((wall, index) => {
      const prevWall = previousState.walls.sellWalls[index] || { q: 0 };
      return { ...wall, delta: wall.q - prevWall.q };
    }),
  };

  // Order Velocity
  const orderVelocity = {
    buy: buyVolume - previousState.volumes.buyVolume,
    sell: sellVolume - previousState.volumes.sellVolume,
  };

  // Delta Analysis
  const priceMovement = midPrice - (previousState.price || midPrice);
  const volumeDelta = buyVolume - sellVolume;
  let signal = "Neutral";
  if (volumeDelta > 100 && priceMovement > 0) signal = "Bullish Confirmation";
  else if (volumeDelta < -100 && priceMovement < 0)
    signal = "Bearish Confirmation";

  // Log Outputs
  logMessage("info", "\n=== Order Book Analysis ===");
  logMessage(
    "info",
    `🔹 Long Weight: ${longWeight.toFixed(8)} | Short Weight: ${shortWeight.toFixed(8)}`,
  );
  logMessage(
    "info",
    `🔹 Best Bid: ${bestBid.toFixed(7)} | Best Ask: ${bestAsk.toFixed(7)} | Mid Price: ${midPrice.toFixed(8)}`,
  );
  logMessage(
    "info",
    `🔹 VWAP: ${vwap.toFixed(8)} | Imbalance: ${imbalance.toFixed(8)} (${imbalance > 0 ? "Bullish" : "Bearish"})`,
  );

  const buySummary = summarizeWalls(wallExhaustion.buy);
  const sellSummary = summarizeWalls(wallExhaustion.sell);

  logMessage(
    "info",
    `🛑 Buy Walls: Min: ${buySummary.min} | Max: ${buySummary.max} | Avg: ${buySummary.avg}`,
  );
  logMessage(
    "info",
    `🛑 Sell Walls: Min: ${sellSummary.min} | Max: ${sellSummary.max} | Avg: ${sellSummary.avg}`,
  );

  logMessage(
    "info",
    `📊 Order Velocity - Buy: ${orderVelocity.buy} | Sell: ${orderVelocity.sell}`,
  );
  logMessage("info", `📈 Signal: ${signal}`);
  logMessage("info", "--------------------------------------");

  // Update previous state
  previousState = {
    price: midPrice,
    volumes: { buyVolume, sellVolume },
    walls: { buyWalls, sellWalls },
  };

  return {
    longWeight,
    shortWeight,
    price: midPrice,
    bestBid,
    bestAsk,
    vwap,
    signal,
    orderVelocity,
    imbalance,
    wallExhaustion,
    bestLongEntry: bestAsk,
    bestShortEntry: bestBid,
    bestLongExit,
    bestShortExit,
    buyClusters,
    sellClusters,
    buyWalls,
    sellWalls,
    volumes: { buyVolume, sellVolume },
    price: midPrice,
    walls: { buyWalls, sellWalls },
  };
};

const evaluateSignalOld = async (input, markPrice, interval) => {
  let smaShort = await sma(3, "close", input);
  let smaLong = await sma(10, "close", input);
  let emaShort = await ema(5, "close", input);
  let emaLong = await ema(15, "close", input);
  let atrData = await atr(7, "close", input); // Capture fast volatility
  let adxData = await adxGet(7, input); // Responsive ADX for short-term trends
  let rsiData = await rsi(7, "close", input); // Quick RSI for overbought/oversold


  // Extract key data points
  const latestSMA_Short = smaShort[smaShort.length - 1];
  const latestSMA_Long = smaLong[smaLong.length - 1];
  const latestEMA_Short = emaShort[emaShort.length - 1];
  const latestEMA_Long = emaLong[emaLong.length - 1];
  const currentATR = atrData[atrData.length - 1];
  const { adx, mdi, pdi } = adxData[adxData.length - 1]; // Extract ADX, MDI, and PDI
  const currentRSI = rsiData[rsiData.length - 1];

  let longSignals = [];
  let shortSignals = [];

  // Evaluate SMA and EMA Crossovers
  if (latestSMA_Short > latestSMA_Long) {
    longSignals.push("SMA Crossover: Short > Long");
  } else {
    shortSignals.push("SMA Crossover: Short < Long");
  }

  if (latestEMA_Short > latestEMA_Long) {
    longSignals.push("EMA Crossover: Short > Long");
  } else {
    shortSignals.push("EMA Crossover: Short < Long");
  }

  // Evaluate Price Position Relative to Averages
  if (markPrice > latestSMA_Short && markPrice > latestEMA_Short) {
    longSignals.push("Price above SMA and EMA: Bullish momentum");
  } else if (markPrice < latestSMA_Short && markPrice < latestEMA_Short) {
    shortSignals.push("Price below SMA and EMA: Bearish momentum");
  }

  // ATR for Volatility Check
  const atrComment = currentATR > markPrice * 0.005
    ? chalk.red("Volatile Market (ATR > 0.5% of Price)")
    : chalk.green("Stable Market (ATR < 0.5% of Price)");

  // ADX Signal for Trend Strength
  if (adx > 25) {
    longSignals.push("ADX > 25: Strong trend detected");
  } else {
    shortSignals.push("ADX < 25: Weak or no trend detected");
  }

  // PDI and MDI Signal
  if (pdi > mdi) {
    longSignals.push("PDI > MDI: Bullish conditions");
  } else if (mdi > pdi) {
    shortSignals.push("MDI > PDI: Bearish conditions");
  }

  // RSI Signal
  if (currentRSI < 30) {
    longSignals.push("RSI < 30: Oversold");
  } else if (currentRSI > 70) {
    shortSignals.push("RSI > 70: Overbought");
  }

  // Supporting data for output
  const supportingData = {
    "SMA (7)": latestSMA_Short.toFixed(8),
    "SMA (25)": latestSMA_Long.toFixed(8),
    "EMA (7)": latestEMA_Short.toFixed(8),
    "EMA (25)": latestEMA_Long.toFixed(8),
    "ATR (14)": {
      Value: currentATR.toFixed(8),
      Comment: atrComment,
    },
    "ADX (14)": {
      Value: adx.toFixed(8),
      Comment: adx > 25 ? "Strong trend" : "Weak trend",
    },
    "PDI (14)": pdi.toFixed(8),
    "MDI (14)": mdi.toFixed(8),
    "RSI (14)": currentRSI.toFixed(8),
    "Mark Price": markPrice.toFixed(8),
  };

  // Convert supporting data to table format
  const tableData = Object.keys(supportingData).map((key) => {
    const data = supportingData[key];
    return {
      Indicator: key,
      Value: typeof data === "object" ? data.Value : data,
      Comment: typeof data === "object" ? data.Comment || "" : "",
    };
  });

  // Table configuration for chalkTable
  const tableConfig = {
    columns: [
      { field: "Indicator", name: chalk.yellow.bold("📊 Indicator") },
      { field: "Value", name: chalk.cyan.bold("🔢 Value") },
      { field: "Comment", name: chalk.magenta.bold("💬 Comment") },
    ],
  };

  // Display Analysis
  console.log(chalk.green.bold(`\n======= Interval: ${interval} =======`));
  console.log(chalk.blue.bold(`🔹 MARK PRICE: ${markPrice}`));
  console.log(chalkTable(tableConfig, tableData));

  // Summary table for signals
  const signalsSummary = [
    { Type: "✅ Long Signals", Count: longSignals.length },
    { Type: "❌ Short Signals", Count: shortSignals.length },
  ];

  console.log(chalk.yellow.bold("\n🚦 Signal Analysis:"));
  console.log(
    chalkTable(
      {
        columns: [
          { field: "Type", name: chalk.green.bold("Type") },
          { field: "Count", name: chalk.blue.bold("Count") },
        ],
      },
      signalsSummary
    )
  );

  if (longSignals.length === 0)
    console.log(chalk.gray(`  • No long signals detected.`));
  if (shortSignals.length === 0)
    console.log(chalk.gray(`  • No short signals detected.`));

  // Final Summary
  console.log(chalk.green.bold(`🏁 Summary:`));
  console.log(`  • Total Long Signals: ${longSignals.length}`);
  console.log(`  • Total Short Signals: ${shortSignals.length}`);
  console.log(chalk.green.bold(`=======================================\n`));

  // Return structured data
  return {
    interval,
    markPrice,
    longSignals,
    shortSignals,
    supportingData: {
      SMA: { short: latestSMA_Short, long: latestSMA_Long },
      EMA: { short: latestEMA_Short, long: latestEMA_Long },
      ATR: currentATR,
      ADX: { value: adx, mdi, pdi },
      RSI: currentRSI,
    },
  };
};


const evaluateSignals = async (input, markPrice, interval) => {
  // Adjusted Parameters for High-Frequency Trading
  let smaShort = await sma(2, "close", input); // Shorter SMA
  let smaLong = await sma(5, "close", input); // Shorter SMA for long-term comparison
  let emaShort = await ema(3, "close", input); // Shorter EMA for quick signals
  let emaLong = await ema(7, "close", input); // Adjusted EMA for trend detection
  let atrData = await atr(5, input); // Shortened ATR for micro-volatility
  let adxData = await adxGet(5, input); // ADX with shorter period for faster trend detection
  let rsiData = await rsi(5, "close", input); // RSI with smaller period for sensitivity

  // Optimized Keltner Channels (EMA 10 and ATR multiplier of 1.5)
  let emaKeltner = await ema(10, "close", input); // Shortened EMA for Keltner Channels
  const latestEMA_Keltner = emaKeltner[emaKeltner.length - 1];
  const currentATR = atrData[atrData.length - 1];
  const upperKeltner = latestEMA_Keltner + .5 * currentATR; // Narrow bands
  const lowerKeltner = latestEMA_Keltner - .5 * currentATR;


  // Extract key data points
  const latestSMA_Short = smaShort[smaShort.length - 1];
  const latestSMA_Long = smaLong[smaLong.length - 1];
  const latestEMA_Short = emaShort[emaShort.length - 1];
  const latestEMA_Long = emaLong[emaLong.length - 1];
  const { adx, mdi, pdi } = adxData[adxData.length - 1];
  const currentRSI = rsiData[rsiData.length - 1];

  let longSignals = [];
  let shortSignals = [];

  // Evaluate SMA and EMA Crossovers
  if (latestSMA_Short > latestSMA_Long) {
    longSignals.push("SMA Crossover: Short > Long");
  } else {
    shortSignals.push("SMA Crossover: Short < Long");
  }

  if (latestEMA_Short > latestEMA_Long) {
    longSignals.push("EMA Crossover: Short > Long");
  } else {
    shortSignals.push("EMA Crossover: Short < Long");
  }

  // Price Position Relative to Averages
  if (markPrice > latestSMA_Short && markPrice > latestEMA_Short) {
    longSignals.push("Price above SMA and EMA: Bullish momentum");
  } else if (markPrice < latestSMA_Short && markPrice < latestEMA_Short) {
    shortSignals.push("Price below SMA and EMA: Bearish momentum");
  }

  // Keltner Channel Signals
  if (markPrice > upperKeltner) {
    longSignals.push("Price above Upper Keltner Channel: Bullish breakout");
  } else if (markPrice < lowerKeltner) {
    shortSignals.push("Price below Lower Keltner Channel: Bearish breakout");
  }

  // ATR for Volatility Check
  const atrComment = currentATR > markPrice * 0.005
    ? chalk.red("Volatile Market (ATR > 0.5% of Price)")
    : chalk.green("Stable Market (ATR < 0.5% of Price)");

  // ADX Signal for Trend Strength
  if (adx > 25) {
    longSignals.push("ADX > 25: Strong trend detected");
  } else {
    shortSignals.push("ADX < 25: Weak or no trend detected");
  }

  // PDI and MDI Signal
  if (pdi > mdi) {
    longSignals.push("PDI > MDI: Bullish conditions");
  } else if (mdi > pdi) {
    shortSignals.push("MDI > PDI: Bearish conditions");
  }

  // RSI Signal
  if (currentRSI < 30) {
    longSignals.push("RSI < 30: Oversold");
  } else if (currentRSI > 70) {
    shortSignals.push("RSI > 70: Overbought");
  }

  // Supporting data for output
  const supportingData = {
    "SMA (3)": latestSMA_Short.toFixed(8),
    "SMA (10)": latestSMA_Long.toFixed(8),
    "EMA (5)": latestEMA_Short.toFixed(8),
    "EMA (15)": latestEMA_Long.toFixed(8),
    "Keltner Channels": {
      Upper: upperKeltner.toFixed(8),
      Middle: latestEMA_Keltner.toFixed(8),
      Lower: lowerKeltner.toFixed(8),
    },
    "ATR (7)": {
      Value: currentATR.toFixed(8),
      Comment: atrComment,
    },
    "ADX (7)": {
      Value: adx.toFixed(8),
      Comment: adx > 25 ? "Strong trend" : "Weak trend",
    },
    "PDI (7)": pdi.toFixed(8),
    "MDI (7)": mdi.toFixed(8),
    "RSI (7)": currentRSI.toFixed(8),
    "Mark Price": markPrice.toFixed(8),
  };

  // Convert supporting data to table format
  const tableData = Object.keys(supportingData).map((key) => {
    const data = supportingData[key];
    return {
      Indicator: key,
      Value: typeof data === "object" ? data.Value || "-" : data,
      Comment: typeof data === "object" ? data.Comment || "" : "",
    };
  });

  // Table configuration for chalkTable
  const tableConfig = {
    columns: [
      { field: "Indicator", name: chalk.yellow.bold("📊 Indicator") },
      { field: "Value", name: chalk.cyan.bold("🔢 Value") },
      { field: "Comment", name: chalk.magenta.bold("💬 Comment") },
    ],
  };

  // Display Analysis
  console.log(chalk.green.bold(`\n======= Interval: ${interval} =======`));
  console.log(chalk.blue.bold(`🔹 MARK PRICE: ${markPrice}`));
  console.log(chalkTable(tableConfig, tableData));

  // Return structured data
  return {
    interval,
    markPrice,
    longSignals,
    shortSignals,
    supportingData,
  };
};




const logMessage = (type, details) => {
  console.log(type === "info" ? chalk.grey(details) : chalk[type](details));
};

var currentTrend;
let lastTradeTime = 0;
const tradeCooldown = 5000; // 10s cooldown
let trendChangeBuffer;

let smoothedImbalance;
let smoothedLongWeight;
let smoothedShortWeight;

let dynamicCooldown
let cooldownRemaining
let remainingCooldown



// async function processSignals(
//   markPrice,
//   signals,
//   volumeSignal,
//   spreadSignal,
//   orderBookAnalysis,
//   openPosition,
// ) {
//   const now = Date.now();
//   const {
//     imbalance,
//     buyWalls,
//     sellWalls,
//     bestLongEntry,
//     bestShortEntry,
//     vwap,
//     volumes: { sellVolume, buyVolume },
//     orderVelocity: { buy: buyVelocity, sell: sellVelocity }
//   } = orderBookAnalysis;

//   const volumeDifferenceThreshold = 0.15; // Example: 5% threshold
//   const velocityThreshold = 0.7; // Example: 10% velocity difference required

//   // Calculate volatility and smoothed imbalance
//   const volatilityFactor = Math.min(1, Math.max(0.1, Math.abs(imbalance) * 2));
//   const dynamicAlpha = 0.1 + 0.1 * volatilityFactor; // Between 0.1 and 0.2
//   smoothedImbalance =
//     smoothedImbalance !== undefined
//       ? dynamicAlpha * imbalance + (1 - dynamicAlpha) * smoothedImbalance
//       : imbalance;

//   // Calculate volume ratio and velocity
//   const volumeRatio = buyVolume / sellVolume;
//   const volumeVelocity = (buyVelocity - sellVelocity) / (buyVelocity + sellVelocity);

//   // Determine trend based on smoothed imbalance, volume velocity, and imbalance velocity
//   let trend = "neutral";
//   if (imbalance > 0) {
//     trend = "long"; // Strong bullish signals
//   } else if (imbalance < -0) {
//     trend = "short"; // Strong bearish signals
//   }

//   // Identify strong walls
//   const strongBuyWalls = buyWalls.filter((wall) => wall.q > buyVolume * 0.05);
//   const strongSellWalls = sellWalls.filter(
//     (wall) => wall.q > sellVolume * 0.05,
//   );

//   // Predict market direction
//   const prediction =
//     strongBuyWalls.length > 0 && smoothedImbalance > 0
//       ? "upward"
//       : strongSellWalls.length > 0 && smoothedImbalance < 0
//         ? "downward"
//         : "neutral";

//   // Calculate dynamic cooldown
//   dynamicCooldown = tradeCooldown * (1 - Math.abs(smoothedImbalance));
//   cooldownRemaining = now - lastTradeTime < dynamicCooldown;

//   remainingCooldown = Math.max(
//     0,
//     dynamicCooldown - (now - lastTradeTime),
//   ); // Ensure no negative cooldown

//   const remainingTimeFormatted = moment.duration(remainingCooldown).humanize(); // Convert to a human-readable format

//   // Calculate volume difference
//   const totalVolume = buyVolume + sellVolume;
//   const volumeDifference = Math.abs(buyVolume - sellVolume) / totalVolume;
//   const absoluteVolumeDifference = Math.abs(buyVolume - sellVolume); // Absolute volume difference
//   const requiredVolumeDifference = totalVolume * volumeDifferenceThreshold; // Threshold in absolute terms

//   // Log input summary with enhanced formatting
//   logMessage("info", "\n========== SIGNAL PROCESSING SUMMARY ==========");
//   logMessage("info", `Mark Price         : ${markPrice.toFixed(8)}`);
//   logMessage(
//     "info",
//     `Imbalance          : ${imbalance.toFixed(8)} | Smoothed: ${smoothedImbalance.toFixed(8)}`,
//   );
//   logMessage(
//     "info",
//     `Trend              : ${trend.toUpperCase()} | Prediction: ${prediction.toUpperCase()}`,
//   );
//   logMessage(
//     "info",
//     `Strong Buy Walls   : ${strongBuyWalls.length} | Strong Sell Walls: ${strongSellWalls.length}`,
//   );
//   logMessage(
//     "info",
//     `Volume Signal      : ${volumeSignal} | Spread Signal: ${spreadSignal}`,
//   );
//   logMessage("info", `VWAP               : ${vwap.toFixed(8)}`);
//   logMessage(
//     "info",
//     `Sell Volume        : ${humanizeNumber(sellVolume)} | Buy Volume: ${humanizeNumber(buyVolume)}`,
//   );
//   logMessage(
//     "info",
//     `Volume Difference  : ${(volumeDifference * 100).toFixed(2)}% (Threshold: ${(volumeDifferenceThreshold * 100).toFixed(2)}%)`,
//   );
//   logMessage(
//     "info",
//     `Absolute Difference: ${humanizeNumber(absoluteVolumeDifference)} (Buy: ${humanizeNumber(buyVolume)}, Sell: ${humanizeNumber(sellVolume)})`,
//   );
//   logMessage(
//     "info",
//     `Required Difference: ${humanizeNumber(requiredVolumeDifference)} (Threshold: ${(volumeDifferenceThreshold * 100).toFixed(2)}% of Total Volume: ${humanizeNumber(totalVolume)})`,
//   );
//   logMessage("info", `Dynamic Cooldown   : ${dynamicCooldown.toFixed(0)}ms`);
//   logMessage(
//     "info",
//     `Cooldown Remaining : ${remainingCooldown > 0 ? "YES" : "NO"} (Ends in ${remainingTimeFormatted})`,
//   );
//   logMessage("info", "===============================================\n");


//   // Decision logic with detailed context for each outcome
//   // Add velocity check to decision logic
//   if (!openPosition && !activeOrder) {
//     if (trend === "neutral") {
//       logMessage(
//         "info",
//         `TRADE SKIPPED: Trend is NEUTRAL (Smoothed Imbalance: ${smoothedImbalance.toFixed(8)}).`,
//       );
//       return;
//     }

//     // const prefferedSide = 'short'
//     // if (trend !== prefferedSide) {
//     //   logMessage(
//     //     "info",
//     //     `TRADE SKIPPED: preffered side is ${prefferedSide}`,
//     //   );
//     //   return;
//     // }

//     // if (cooldownRemaining) {
//     //   logMessage(
//     //     "info",
//     //     `TRADE SKIPPED: Still in cooldown. Ends in ${(dynamicCooldown - (now - lastTradeTime)).toFixed(0)}ms.`,
//     //   );
//     //   return;
//     // }

//     // Volume difference check
//     // if (absoluteVolumeDifference < requiredVolumeDifference) {
//     //   logMessage(
//     //     "info",
//     //     `TRADE SKIPPED: Insufficient volume difference (${humanizeNumber(absoluteVolumeDifference)}). Required: ${humanizeNumber(requiredVolumeDifference)}.`,
//     //   );
//     //   return;
//     // }

//     // // Velocity check
//     // if (
//     //   (trend === "long" && volumeVelocity < velocityThreshold) ||
//     //   (trend === "short" && volumeVelocity > -velocityThreshold)
//     // ) {
//     //   logMessage(
//     //     "info",
//     //     `TRADE open  SKIPPED: Insufficient velocity (${volumeVelocity.toFixed(2)}). Required: ${trend === "long" ? ">" : "< -"}${velocityThreshold}.`,
//     //   );
//     //   return;
//     // }



//     // // Log position opening attempt
//     const entryPrice = trend === "long" ? bestLongEntry : bestShortEntry;
//     logMessage("info", `>>> OPENING ${trend.toUpperCase()} POSITION <<<`);
//     logMessage(
//       "info",
//       `Entry Price        : ${entryPrice.toFixed(8)} | Mark Price: ${markPrice.toFixed(8)}`,
//     );

//     // Attempt to create the position
//     try {
//       activeOrder = await createPosition(
//         side,
//         currentPrice,
//         orderBookAnalysis,
//         signals,
//         smoothedImbalance,
//         {
//           smaShort,
//           smaLong,
//           emaShort,
//           emaLong,
//         }
//       );
//       lastTradeTime = now;
//       logMessage(
//         "info",
//         `SUCCESS: Opened ${trend.toUpperCase()} position at ${entryPrice.toFixed(8)}.`,
//       );
//     } catch (error) {
//       logMessage(
//         "red",
//         `FAILED: Could not open position. Error: ${error.message}`,
//       );
//     }
//   } else if (trend !== activeOrder?.side) {
//     // // Check if volume and velocity confirm the trend change
//     // const isTrendConfirmed =
//     //   (trend === "long" && volumeVelocity >= velocityThreshold) ||
//     //   (trend === "short" && volumeVelocity <= -velocityThreshold);

//     // if (!isTrendConfirmed) {
//     //   logMessage(
//     //     "yellow",
//     //     `Trend change detected, but insufficient confirmation from volume and velocity. Skipping closure.`
//     //   );
//     //   return; // Do not proceed if trend change is not confirmed
//     // }

//     // Close position immediately on trend change
//     // logMessage(
//     //   "info",
//     //   `>>> CLOSING ${activeOrder?.side.toUpperCase()} POSITION due to trend change <<<`,
//     // );
//     // logMessage(
//     //   "info",
//     //   `Entry Price        : ${activeOrder.entryPrice.toFixed(8)} | Mark Price: ${markPrice.toFixed(8)}`,
//     // );

//     try {
//       await closePosition(markPrice,
//         orderBookAnalysis,
//         absoluteVolumeDifference,
//         volumeVelocity,
//         velocityThreshold
//       );
//       activeOrder = null; // Clear active order
//       lastTradeTime = now;
//       logMessage(
//         "info",
//         `SUCCESS: Closed ${activeOrder?.side?.toUpperCase()} position.`,
//       );
//     } catch (error) {
//       logMessage(
//         "red",
//         `FAILED: Could not close position. Error: ${error.message}`,
//       );
//       return; // Stop further processing if position couldn't be closed
//     }

//     // After closing, decide whether to open a new position based on velocity
//     if (
//       (trend === "long" && volumeVelocity >= velocityThreshold) ||
//       (trend === "short" && volumeVelocity <= -velocityThreshold)
//     ) {
//       const entryPrice = trend === "long" ? bestLongEntry : bestShortEntry;
//       logMessage("info", `>>> OPENING NEW ${trend.toUpperCase()} POSITION <<<`);
//       logMessage(
//         "info",
//         `Entry Price        : ${entryPrice.toFixed(8)} | Mark Price: ${markPrice.toFixed(8)}`,
//       );

//       try {
//         activeOrder = await createPosition(
//           trend,
//           markPrice,
//           orderBookAnalysis,
//           signals,
//           smoothedImbalance,
//           {
//             smaShort,
//             smaLong,
//             emaShort,
//             emaLong,
//           }
//         );
//         lastTradeTime = now;
//         logMessage(
//           "info",
//           `SUCCESS: Opened ${trend.toUpperCase()} position at ${entryPrice.toFixed(8)}.`,
//         );
//       } catch (error) {
//         logMessage(
//           "red",
//           `FAILED: Could not open new position. Error: ${error.message}`,
//         );
//       }
//     } else {
//       logMessage(
//         "info",
//         `TRADE SKIPPED: Insufficient velocity (${volumeVelocity.toFixed(2)}). Required: ${trend === "long" ? "≥" : "≤"} ${velocityThreshold}.`,
//       );
//     }
//   }

//   if (openPosition) {
//     // Calculate if volume difference still qualifies
//     const totalVolume = buyVolume + sellVolume;
//     const volumeDifference = Math.abs(buyVolume - sellVolume) / totalVolume;
//     const absoluteVolumeDifference = Math.abs(buyVolume - sellVolume);
//     const requiredVolumeDifference = totalVolume * volumeDifferenceThreshold;

//     if (absoluteVolumeDifference < requiredVolumeDifference) {
//       logMessage(
//         "info",
//         `>>> CLOSING POSITION: Volume difference no longer qualifies <<<`,
//       );
//       logMessage(
//         "info",
//         `Current Volume Difference: ${(volumeDifference * 100).toFixed(2)}% (Required: ${(volumeDifferenceThreshold * 100).toFixed(2)}%)`,
//       );

//       try {
//         await closePosition(markPrice,
//           orderBookAnalysis,
//           absoluteVolumeDifference,
//           volumeVelocity,
//           velocityThreshold
//         );
//         activeOrder = null; // Clear active order
//         lastTradeTime = now;
//         logMessage(
//           "info",
//           `SUCCESS: Closed ${activeOrder?.side?.toUpperCase()} position due to insufficient volume difference.`,
//         );
//       } catch (error) {
//         logMessage(
//           "red",
//           `FAILED: Could not close position. Error: ${error.message}`,
//         );
//       }

//       return; // Exit function after closing the position
//     }
//   }




//   logMessage("info", "-----------------------------------------------\n");
// }


var lastTradeTimestamp;
let trend = "neutral";
async function processSignalsWithMA(
  markPrice,
  signals,
  volumeSignal,
  spreadSignal,
  orderBookAnalysis
) {
  const openPosition = activeOrder;
  const now = Date.now();


  const { imbalance, bestLongEntry, bestShortEntry, sellWalls, buyWalls, volumes: { buyVolume, sellVolume } } = orderBookAnalysis;
  const {
    interval,
    longSignals,
    shortSignals,
    supportingData: {
      "SMA (3)": smaShort,
      "SMA (10)": smaLong,
      "EMA (5)": emaShort,
      "EMA (15)": emaLong,
      "Keltner Channels": keltnerChannels,
      "ADX (7)": { Value: adx },
      "PDI (7)": pdi,
      "MDI (7)": mdi,
      "RSI (7)": rsi,
    },
  } = signals["5m"];

  const keltnerUpper = parseFloat(keltnerChannels.Upper);
  const keltnerLower = parseFloat(keltnerChannels.Lower);
  const keltnerMiddle = parseFloat(keltnerChannels.Middle);

  // Log the Volume Signal
  logMessage("info", `Volume Analysis: ${volumeSignal}`);

  // Filter based on Volume Signal
  if (volumeSignal.includes("Volume drop")) {
    logMessage("yellow", `Skipping trade due to low market activity: ${volumeSignal}`);
    // return;
  }

  if (volumeSignal.includes("Volume spike")) {
    logMessage("info", `High market activity detected. Proceeding with trade analysis.`);
  } else if (volumeSignal.includes("Moderate volume increase")) {
    logMessage("info", `Moderate market activity detected. Proceeding with caution.`);
  }

  // Compare buy and sell volumes
  const volumeRatio = buyVolume / sellVolume;
  logMessage("info", `Order Book Volume Analysis: Buy Volume = ${buyVolume}, Sell Volume = ${sellVolume}, Ratio = ${volumeRatio.toFixed(2)}`);

  // Define volume thresholds
  const BUY_VOLUME_THRESHOLD = 0.7;
  const SELL_VOLUME_THRESHOLD = 0.7;
  const ADX_THRESHOLD = 30;

  // // Adjust trend based on volume dominance
  if (volumeRatio > BUY_VOLUME_THRESHOLD && adx >= ADX_THRESHOLD) {
    trend = "long";
    logMessage("info", `Buy volume dominates (Ratio: ${volumeRatio.toFixed(2)}). Trend set to LONG.`);
    logMessage("info", `
      --- Decision Explanation ---
      The buy volume is significantly higher than the sell volume (${volumeRatio.toFixed(2)} > ${BUY_VOLUME_THRESHOLD}),
      indicating buying dominance.
      The ADX (${adx}) confirms a strong upward trend as it is above the threshold (${ADX_THRESHOLD}).
      Therefore, the trend is set to "LONG" as the market shows signs of rising prices.
    `);
  } else if (volumeRatio < SELL_VOLUME_THRESHOLD && adx >= ADX_THRESHOLD) {
    trend = "short";
    logMessage("info", `Sell volume dominates (Ratio: ${volumeRatio.toFixed(2)}). Trend set to SHORT.`);
    logMessage("info", `
      --- Decision Explanation ---
      The sell volume is significantly higher than the buy volume (${volumeRatio.toFixed(2)} < ${SELL_VOLUME_THRESHOLD}),
      indicating selling dominance.
      The ADX (${adx}) confirms a strong downward trend as it is above the threshold (${ADX_THRESHOLD}).
      Therefore, the trend is set to "SHORT" as the market shows signs of falling prices.
    `);
  } else {
    logMessage("info", `Volume Ratio (${volumeRatio.toFixed(2)}) indicates no clear dominance. ADX is ${adx}`);
    logMessage("info", `
      --- Decision Explanation ---
      The volume ratio (${volumeRatio.toFixed(2)}) does not breach the thresholds for buying (${BUY_VOLUME_THRESHOLD})
      or selling (${SELL_VOLUME_THRESHOLD}), indicating no clear market dominance.
      Additionally, the ADX (${adx}) is either below the threshold (${ADX_THRESHOLD}) or not strong enough to confirm
      a trend. This suggests the market is indecisive or in consolidation.
      No specific trend is set at this time.
    `);
    logMessage("info", `
      --- Debug Information ---
      Volume Ratio: ${volumeRatio.toFixed(2)}
      ADX: ${adx}
      BUY_VOLUME_THRESHOLD: ${BUY_VOLUME_THRESHOLD}
      SELL_VOLUME_THRESHOLD: ${SELL_VOLUME_THRESHOLD}
      ADX_THRESHOLD: ${ADX_THRESHOLD}
    `);
  }



  // Improved long and short entry conditions
  if (trend === "long") {
    if (rsi < 50 && markPrice > smaLong && adx > ADX_THRESHOLD) {
      logMessage("info", `Strong trend confirmed: RSI = ${rsi}, Price above SMA(10) = ${smaLong}, ADX = ${adx}. Entering LONG position.`);
    } else {
      logMessage("yellow", `Skipping long trade: Conditions not met. RSI: ${rsi}, Price: ${markPrice}, SMA(10): ${smaLong}`);
      // return;
    }
  }

  if (trend === "short") {
    if (rsi > 10 && markPrice < smaShort && adx > ADX_THRESHOLD) {
      logMessage("info", `Strong trend confirmed: RSI = ${rsi}, Price below SMA(3) = ${smaShort}, ADX = ${adx}. Entering SHORT position.`);
    } else {
      logMessage("yellow", `Skipping short trade: Conditions not met. RSI: ${rsi}, Price: ${markPrice}, SMA(3): ${smaShort}`);
      // return;
    }
  }

  // Combine Trend and Order Book Data for Entry Price
  const entryPrice =
    trend === "long"
      ? Math.min(bestLongEntry, markPrice)
      : Math.max(bestShortEntry, markPrice);

  logMessage("info", `Determined entry price: ${entryPrice}`);

  // Execute Trade
  if (!activeOrder && trend !== "neutral") {
    logMessage("info", `>>> INITIATING NEW TRADE <<<`);
    logMessage("info", `Opening ${trend.toUpperCase()} position at Entry Price: ${entryPrice}`);

    if (lastTradeTimestamp && now - lastTradeTimestamp < tradeCooldown) {
      logMessage("info", "Recomending Skipping trade: Cooldown in effect. diving in");
      return;
    }
    lastTradeTimestamp = now;

    // try {
      activeOrder = await createPosition(trend, markPrice, orderBookAnalysis, signals, imbalance);
      if (activeOrder) logMessage("green", `SUCCESS: ${trend.toUpperCase()} position opened.`);
    // } catch (error) {
    //   logMessage("red", `ERROR: Could not open ${trend.toUpperCase()} position. Details: ${error.message}`);
    // }
  }

  // Function to evaluate trend weakening
  const isTrendWeakening = (adx, rsi, activeSide) => {
    const adxThreshold = 25; // ADX below this indicates a weak trend
    const rsiOverbought = 70; // RSI above this indicates overbought
    const rsiOversold = 30; // RSI below this indicates oversold

    // Weak trend condition based on ADX
    if (adx < adxThreshold) {
      logMessage("yellow", `Trend Weakening Signal: ADX (${adx}) is below the threshold (${adxThreshold}). Indicates a weak trend.`);
      return true;
    }

    // RSI condition for LONG position
    if (activeSide === "long" && rsi >= rsiOverbought) {
      logMessage("yellow", `Trend Weakening Signal: RSI (${rsi}) is above overbought threshold (${rsiOverbought}) for a LONG position.`);
      return true;
    }

    // RSI condition for SHORT position
    if (activeSide === "short" && rsi <= rsiOversold) {
      logMessage("yellow", `Trend Weakening Signal: RSI (${rsi}) is below oversold threshold (${rsiOversold}) for a SHORT position.`);
      return true;
    }

    // If no weakening signal, trend is considered strong
    logMessage("green", `Trend Strength: ADX (${adx}) is strong and RSI (${rsi}) does not indicate overbought/oversold conditions.`);
    return false;
  };

  let currentTrend;
  const COOLDOWN_PERIOD = 300000; // Cooldown period in milliseconds (e.g., 5 minutes)
  let lastVolumeSpikeTime = 0; // Track the last time a volume spike was detected
  // Check cooldown
  const isInCooldown = Date.now() - lastVolumeSpikeTime < COOLDOWN_PERIOD;

  // Check if we should close the position
  if (activeOrder) {
    logMessage(
      "info",
      `Position Check: Currently holding a ${activeOrder.side.toUpperCase()} position. Evaluating market conditions to decide if the position should remain open.`
    );

    // Volume and market direction analysis
    currentTrend = buyVolume > sellVolume ? "long" : "short";
    logMessage(
      "info",
      `Market Overview: Current trend direction based on volume is ${currentTrend?.toUpperCase()}. Active position side is ${activeOrder.side.toUpperCase()}.`
    );

    // Evaluate trend weakening
    const isTrendWeakeningValue = isTrendWeakening(adx, rsi, activeOrder.side);

    // Check for volume spike signals
    if (volumeSignal.includes("Volume spike")) {
      logMessage("yellow", `Volume Spike Detected: ${volumeSignal}. Activating cooldown mechanism.`);
      lastVolumeSpikeTime = Date.now(); // Update last spike time
    }



    // Check if the trend is weakening or if there's a reversal
    if (
      (trend !== activeOrder.side || isTrendWeakeningValue || isInCooldown) &&
      activeOrder.side !== currentTrend
    ) {
      logMessage(
        "yellow",
        `Action Required: Market trend or conditions have changed. Closing the ${activeOrder.side.toUpperCase()} position to mitigate risks. Cooldown status: ${isInCooldown ? "ACTIVE" : "INACTIVE"}.`
      );

      // Close the position if conditions meet
      logMessage(
        "info",
        `Position Closure: Mark price at closure is ${markPrice}. Position will be closed to mitigate risk and lock in potential profits/losses.`
      );
      // closePosition(markPrice);

      logMessage(
        "green",
        `Position Closed: Successfully exited ${activeOrder.side.toUpperCase()} position at mark price ${markPrice}.`
      );
      return;
    }

    // If trend matches and no signs of weakening
    logMessage(
      "green",
      `No Action Required: Market conditions align with the active ${activeOrder.side.toUpperCase()} position. The trend (${currentTrend?.toUpperCase()}) supports this direction, and no weakening signals are detected. Position remains open.`
    );
  } else {
    logMessage(
      "info",
      `Position Check: No active positions. The system is not holding any trades at the moment. Awaiting new trading opportunities.`
    );
  }

  // Final state logging
  logMessage(
    "info",
    `Position Check Summary: Active order status is ${activeOrder ? "ACTIVE" : "NONE"
    }. Current market volume trend is ${currentTrend?.toUpperCase()}. Cooldown status: ${isInCooldown ? "ACTIVE" : "INACTIVE"
    }.`
  );




}



// Function to calculate ATR (Average True Range)
function calculateATR(period = 14) {
  // Placeholder for ATR calculation logic
  // In reality, you would need to gather historical price data and calculate ATR
  // For now, just return a mock value
  return 0.02; // Example mock ATR value
}




let humanizeNumber = (number = 0) => {
  if (typeof number === "string") {
    number = parseFloat(number);
  }
  if (isNaN(number)) {
    return number; // or some default value if you want
  }
  if (number < 1000) return number.toFixed(3);
  if (number < 1000000) return (number / 1000).toFixed(3) + "k";
  if (number < 1000000000) return (number / 1000000).toFixed(3) + "M";
  return (number / 1000000000).toFixed(3) + "B";
};

// Helper Function to Log Performance Metrics
function logPerformanceMetrics(metrics) {
  console.log("\n");
  console.log(
    chalk.cyan(` • Num Trades: ${humanizeNumber(metrics.numTrades)}`),
  );
  console.log(
    chalk.green(` • Profit/Loss: ${humanizeNumber(metrics.profitLoss)}`),
  );
  console.log(chalk.yellow(` • Win Rate: ${metrics.winRate.toFixed(2)}%`));
  console.log(
    chalk.magenta(` • Average Win: ${humanizeNumber(metrics.averageWin)}`),
  );
  console.log(
    chalk.red(` • Average Loss: ${humanizeNumber(metrics.averageLoss)}`),
  );
  console.log(
    chalk.grey(` • Drawdown: ${humanizeNumber(metrics.currentDrawdown)}`),
  );
  console.log(
    chalk.red(` • Max Drawdown: ${humanizeNumber(metrics.maxDrawdown)}`),
  );
  console.log(chalk.blue(` • Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`));
  console.log(
    chalk.blue(` • Sortino Ratio: ${metrics.sortinoRatio.toFixed(2)}`),
  );
  console.log(
    chalk.yellow(` • Risk-Reward Ratio: ${metrics.riskRewardRatio.toFixed(2)}`),
  );
  console.log(
    chalk.greenBright(` • Profit Factor: ${metrics.profitFactor.toFixed(2)}`),
  );
  console.log(
    chalk.cyanBright(
      ` • Consistency Score: ${metrics.consistencyScore.toFixed(2)}`,
    ),
  );
  console.log("\n");
}

async function loadSession() {
  const data = await readFile(sessionPath, "utf8");
  return Buffer.from(data);
}

let lastMarkPriceFetch = Date.now();
let openPositions = [];

let markPrice
const main = async () => {
  console.log(chalk.cyan("\nStarting trading session..."));

  // try {

  // Ensure the session file exists
  if (!fs.existsSync(sessionPath)) {
    console.log(
      chalk.yellow("Session file not found. Creating a new session file..."),
    );
    const defaultSession = {
      orders: [],
      longPosition: false,
      shortPosition: false,
    };
    fs.writeFileSync(sessionPath, JSON.stringify(defaultSession, null, 2));
  }


  const json = await loadSession();
  const parsedSession = JSON.parse(json);

  // Validate session data before using
  if (!parsedSession.orders || !Array.isArray(parsedSession.orders)) {
    parsedSession.orders = [];
  }
  if (typeof parsedSession.longPosition !== "boolean")
    parsedSession.longPosition = false;
  if (typeof parsedSession.shortPosition !== "boolean")
    parsedSession.shortPosition = false;

  session.orders = parsedSession.orders;

  const accountInfo = await binance.futuresBalance();
  const usdtAsset = !accountInfo.find
    ? []
    : accountInfo.find((asset) => asset.asset === "USDT");
  if (!usdtAsset) {
    console.error(
      chalk.red(`Error: USDT asset not found in account information`),
    );
  }

  console.log(
    `  • Available Balance: ${humanizeNumber(usdtAsset.availableBalance || 0)} USDT`,
  );
  console.log(`  • Invested: ${humanizeNumber(invested)} USDT`);

  setInterval(async () => {
    // try {
      const positions = await binance.futuresPositionRisk();

      lastMarkPriceFetch = Date.now();
      let response = await binance.futuresMarkPrice(market);
      if (!response.markPrice) throw new Error("Failed to fetch mark price");
      markPrice = parseFloat(response.markPrice);

      // Filter positions to get only those that are open (positionAmt !== 0)
      openPositions = positions.code
        ? []
        : positions.filter((position) => position.positionAmt != 0);

      openPositions = openPositions.map(async (position) => {
        // Extract and parse position details
        const symbol = position.symbol;
        const size = mathjs.abs(parseFloat(position.positionAmt)); // Absolute position size
        const positionAmt = parseFloat(position.positionAmt);
        // Determine side based on positionAmt
        const side = mathjs.abs(positionAmt) > 0 ? "long" : positionAmt < 0 ? "short" : null;

        const entryPrice = parseFloat(position.entryPrice); // Entry price
        const markPrice = parseFloat(position.markPrice); // Current market price
        const liqPrice = parseFloat(position.liquidationPrice); // Liquidation price
        // const leverage = parseFloat(position.leverage); // Leverage used
        const unrealizedProfit = parseFloat(position.unRealizedProfit); // Unrealized PnL
        const notional = parseFloat(position.notional); // Position value
        const maxNotionalValue = parseFloat(position.maxNotionalValue); // Max allowable notional value

        // Calculations
        const margin = mathjs.divide(mathjs.abs(notional), leverage); // Margin used
        const marginRatio = mathjs.multiply(
          mathjs.divide(mathjs.abs(notional), maxNotionalValue),
          100,
        ); // Margin ratio
        const pnl = mathjs.multiply(
          mathjs.subtract(markPrice, entryPrice),
          size,
          leverage,
        ); // Total PnL
        const pnlPercentage = mathjs.round(
          mathjs.multiply(mathjs.divide(unrealizedProfit, margin), 100),
          2,
        ); // PnL %
        const roi = mathjs.round(
          mathjs.multiply(mathjs.divide(unrealizedProfit, margin), 100),
          2,
        ); // ROI %

        // Log the details
        console.log(`${chalk.bold(symbol)}:`);
        console.log(`  Size: ${chalk.yellow(`${size.toFixed(8)}`)} units`);
        console.log(`  Entry Price: ${chalk.blue(`${entryPrice.toFixed(8)}`)}`);
        console.log(`  Mark Price: ${chalk.green(`${markPrice.toFixed(8)}`)}`);
        console.log(
          `  Liquidation Price: ${chalk.bgRed(`${liqPrice.toFixed(8)}`)}`,
        );
        console.log(
          `  Margin Ratio: ${chalk.dim(`${marginRatio.toFixed(2)}%`)}`,
        );
        console.log(`  Margin: ${chalk.dim(`${margin.toFixed(8)} USDT`)}`);
        console.log(
          `  PnL: ${chalk[pnl > 0 ? "green" : "red"](`${pnl.toFixed(2)} USDT`)}`,
        );
        console.log(
          `  PnL Percentage: ${chalk[pnlPercentage > 0 ? "green" : "red"](`${pnlPercentage.toFixed(2)}%`)}`,
        );
        console.log(
          `  ROI: ${chalk[roi > 0 ? "green" : "red"](`${roi.toFixed(2)}%`)}`,
        );
        console.log("------------------------");

        // Create the order details object with all the necessary properties
        const simulatedOrderDetails = {
          id: position.orderId,
          symbol: symbol,
          size: size.toFixed(8),
          side,
          entryPrice: entryPrice.toFixed(8),
          markPrice: markPrice.toFixed(8),
          liquidationPrice: liqPrice.toFixed(8),
          leverage: leverage,
          unrealizedProfit: unrealizedProfit.toFixed(8),
          margin: margin.toFixed(8), // Margin used
          marginRatio: marginRatio.toFixed(2), // Margin ratio
          pnl: pnl.toFixed(2), // Profit/Loss
          pnlPercentage: pnlPercentage, // PnL %
          roi: roi, // Return on Investment
          notional: notional.toFixed(8),
          status: "Simulated",
          entryTimestamp: Date.now(),
        };

        // console.log("Simulated Order Details:", simulatedOrderDetails);

        // Check PnL percentage for position closure

        //  else if


        if (pnlPercentage >= targetPnl) {
          logMessage("info", `>>> High PnL% Detected <<<`);
          logMessage("info", `Closing position at mark price: ${markPrice.toFixed(8)}`);

          // try {
            await closePosition(markPrice);
            activeOrder = undefined; // Clear active order
            logMessage("green", `SUCCESS: Position closed. Ready to re-invest.`);
          // } catch (error) {
          //   logMessage("red", `ERROR: Could not close position. Reason: ${error.message}`);
          // }
        }

        if (pnlPercentage <= -100) {
          logMessage("info", `>>> Liquidation Negative PnL% Detected <<<`);
          logMessage("info", `Closing position at mark price: ${markPrice.toFixed(8)}`);

          // try {
            await closePosition(markPrice);
            activeOrder = undefined; // Clear active order
            logMessage("green", `SUCCESS: Position closed. Ready to re-invest.`);
          // } catch (error) {
          //   logMessage("red", `ERROR: Could not close position. Reason: ${error.message}`);
          // }
        }

        // Assign the simulated order details to activeOrder
        //
        return simulatedOrderDetails;
      });

      openPositions = await Promise.all(openPositions)

      activeOrder = session.orders.find((order) => !order.exitPrice) || openPositions[0];

      if (activeOrder) {
        console.log("Active order found.");

        // Perform calculations and assign to activeOrder
        activeOrder = Object.assign({}, activeOrder, {
          positionSize: Math.abs(parseFloat(activeOrder.positionAmt)), // Absolute position size
          margin: parseFloat(activeOrder.margin), // Margin directly from the object
          pnl: Math.round(
            (markPrice - activeOrder.entryPrice) * activeOrder.positionAmt * leverage * 100
          ) / 100, // Total PnL rounded to 2 decimals
          pnlPercentage: Math.round(
            ((markPrice - activeOrder.entryPrice) * activeOrder.positionAmt * leverage * 100) /
            activeOrder.margin
          ) / 100, // PnL percentage rounded to 2 decimals
        });

        // Log the enhanced activeOrder
        // console.log(`Enhanced Active Order:`, activeOrder);

        // // Check PnL percentage and decide to close
        // if (activeOrder.pnl >= targetPnl) {
        //   console.log(
        //     `Closing position for ${activeOrder.symbol}. PnL reached ${activeOrder.pnlPercentage}%`
        //   );
        //   // Add your close position logic here
        //   await closePosition(markPrice); // Replace with your method to close the position
        // } else if (activeOrder.pnl <= -100) {
        //   logMessage("info", `>>> Liquidation Negative PnL% Detected <<<`);
        //   logMessage("info", `Closing position at mark price: ${markPrice.toFixed(8)}`);

        //   try {
        //     await closePosition(markPrice);
        //     activeOrder = undefined; // Clear active order
        //     logMessage("green", `SUCCESS: Position closed. Ready to re-invest.`);
        //   } catch (error) {
        //     logMessage("red", `ERROR: Could not close position. Reason: ${error.message}`);
        //   }
        // } else {
        //   console.log(
        //     `PnL for ${activeOrder.symbol} is ${activeOrder.pnlPercentage}%, below target of ${targetPnl}%`
        //   );
        // }
        // return;
      }


      let { aggTrades, recentTrades, historicalTrades, orderBook } =
        await fetchOrderBookData(market);
      let volumeSignal = analyzeVolume(aggTrades, recentTrades);
      let spreadSignal = analyzeSpread(orderBook);
      let orderBookAnalysis = analyzeOrderBook(
        aggTrades,
        recentTrades,
        historicalTrades,
      );
      // previousState = orderBookAnalysis

      // if (Date.now() - lastMarkPriceFetch > 2000) {


      let mergedSignals = {};

      await Promise.all(
        intervals.map(async (interval) => {
          let { input } = await getDetachSourceFromOHLCV(
            exchange,
            market,
            interval,
            getFutureMarket,
          );

          // separates the signals into long or short
          let signal = await evaluateSignals(input, markPrice, interval);
          mergedSignals[interval] = signal;
        }),
      );

      console.log("\n");
      // Log the signals for transparency
      console.log(chalk.blue(`Volume Signal: ${volumeSignal}`));
      console.log(chalk.blue(`Spread Signal: ${spreadSignal}`));
      console.log("\n");

      // if (!openPositions[0] && liveMode) {
      //   // Find and update the order in session.orders
      //   const existingOrder = session.orders.find((order) => !order.exitPrice);
      //   if (existingOrder) {
      //     activeOrder = existingOrder
      //     liveMode = false
      //     closePosition(markPrice)
      //     activeOrder = existingOrder
      //     console.log(`Order with ID ${existingOrder?.id} updated successfully in session to closed at current markprice.`);
      //     liveMode = true
      //   } else {
      //     console.warn(`No order was found without an exitPrice to update, no action taken locally to sync with binance.`);
      //   }
      // }

      processSignalsWithMA(
        markPrice,
        mergedSignals,
        volumeSignal,
        spreadSignal,
        orderBookAnalysis,
      );

      // reset metrics parameters
      performanceMetrics = {
        profitLoss: 0, // Total profit/loss across all trades
        numTrades: 0, // Total number of trades
        winRate: 0, // Percentage of winning trades
        averageWin: 0, // Average profit per winning trade
        averageLoss: 0, // Average loss per losing trade
        maxDrawdown: 0, // Maximum drawdown observed
        currentDrawdown: 0, // Current drawdown
        longestWinStreak: 0, // Longest consecutive winning streak
        longestLossStreak: 0, // Longest consecutive losing streak
        sharpeRatio: 0, // Sharpe Ratio (risk-adjusted return)
        sortinoRatio: 0, // Sortino Ratio (downside risk-adjusted return)
        drawdown: 0, // Current cumulative drawdown
        totalWins: 0, // Total number of winning trades
        totalLosses: 0, // Total number of losing trades
        totalWinAmount: 0, // Total profit from winning trades
        totalLossAmount: 0, // Total loss from losing trades
        riskRewardRatio: 0, // Average risk-reward ratio
        profitFactor: 0, // Total profit divided by total loss
        consistencyScore: 0, // Ratio of longest win streak to longest loss streak
      };

      console.log(chalk.blue(`\nSymbol: ${market}`));
      console.log(chalk.blue(`Investment Balance: $ ${humanizeNumber(invested)}`));
      console.log(chalk.blue(`MarkPrice: ${markPrice}`));
      console.log(chalk.blue(`Openned Orders:`));
      const tableOptions = {
        leftPad: 2,
        columns: [
          { field: "index", name: chalk.dim("ID") },
          { field: "side", name: chalk.magenta("Side") },
          // { field: "time", name: chalk.gray("Time") },
          { field: "symbol", name: chalk.gray("Symbol") },
          { field: "size", name: chalk.yellow("Size") },
          { field: "entryPrice", name: chalk.blue("Entry Price") },
          { field: "stopPrice", name: chalk.blue("TP Price") },
          { field: "exitPrice", name: chalk.blue("Exit Price") },
          { field: "leverage", name: chalk.dim("Leverage") },
          { field: "margin", name: chalk.dim("Margin") },
          // { field: "pnl", name: chalk.dim("pnl") },
          // { field: "pnlPercentage", name: chalk.dim("pnlPercentage") },
          { field: "notional", name: chalk.dim("Notional") },

          // { field: "marginRatio", name: chalk.dim("Margin Ratio") },
          { field: "pnl", name: chalk.green("P/L") },
          // { field: "tPPnlPercentage", name: chalk.green("TP P/L %") },
          { field: "pnlPercentage", name: chalk.green("Current P/L %") },
          // { field: "roi", name: chalk.green("ROI") },
          { field: "duration", name: chalk.gray("Duration") },
          { field: "status", name: chalk.green("Status") },
          // { field: "buyTSummary", name: chalk.green("buyTSummary") },
          // { field: "sellTSummary", name: chalk.yellow("sellTSummary") },
        ],
      };

      const tableData = await Promise.all(session.orders
        // .filter(order => !order.exitPrice)
        .map((order, index) => {

          return {
            ...order, // Copy existing properties
            side: order.side
              ? order.side
              : order.positionAmt < 0
                ? "short"
                : "long", // Add 'side' key
            index, // Optional: Adding index if needed
          };
        })
        .map(async (order, index) => {
          const symbol = order.symbol;
          const {
            absoluteVolumeDifference,
            volumeVelocity,
            velocityThreshold,
            buyVolume,
            sellVolume,
            closeSummary = {}
          } = order
          const size = mathjs.abs(parseFloat(order.positionAmt || order.size)); // Absolute position size
          const entryPrice = parseFloat(order.entryPrice); // Entry price of the position
          const stopPrice = order.stopPrice
            ? parseFloat(order.stopPrice)
            : undefined; // Stop price if defined
          const liqPrice = parseFloat(order.liquidationPrice); // Liquidation price

          const leverage = parseFloat(order.leverage); // Leverage used
          const exitTime = order.exitTime || undefined; // Exit time if position is closed
          // const markPrice = parseFloat(markPrice); // Mark price
          const breakEvenPrice = parseFloat(order.breakEvenPrice); // Break-even price if applicable

          // Stop loss and take profit prices
          const stopLoss = order.stopLoss ? parseFloat(order.stopLoss) : undefined;
          const takeProfit = order.takeProfit ? parseFloat(order.takeProfit) : undefined;

          // Calculate notional value
          const notional = mathjs.multiply(entryPrice, size);

          // Margin calculation

          const sideMultiplier = order.side === "long" ? 1 : -1;

          const margin =
            leverage > 0
              ? mathjs.round(mathjs.divide(notional, leverage), 8)
              : 0;

          // Calculate potential PnL at stop loss
          const stopLossPnl =
            stopLoss && entryPrice > 0 && size > 0
              ? mathjs.round(
                mathjs.multiply(
                  (stopLoss - entryPrice) * sideMultiplier,
                  size,
                ),
                8,
              )
              : undefined;

          // Calculate potential PnL at take profit
          const takeProfitPnl =
            takeProfit && entryPrice > 0 && size > 0
              ? mathjs.round(
                mathjs.multiply(
                  (takeProfit - entryPrice) * sideMultiplier,
                  size,
                ),
                8,
              )
              : undefined;

          // Calculate potential PnL percentages
          const stopLossPnlPercentage =
            stopLossPnl !== undefined && margin > 0
              ? mathjs.round(mathjs.multiply(mathjs.divide(stopLossPnl, margin), 100), 2)
              : undefined;

          const takeProfitPnlPercentage =
            takeProfitPnl !== undefined && margin > 0
              ? mathjs.round(mathjs.multiply(mathjs.divide(takeProfitPnl, margin), 100), 2)
              : undefined;

          // Log potential outcomes
          // console.log(`Potential PnL at Stop Loss: ${stopLossPnl} (${stopLossPnlPercentage}%)`);
          // console.log(`Potential PnL at Take Profit: ${takeProfitPnl} (${takeProfitPnlPercentage}%)`);


          // Determine effective mark price (use exitPrice or markPrice as fallback)
          const exitPrice = order.exitPrice
            ? parseFloat(order.exitPrice)
            : undefined; // Exit price if closed
          const effectiveMarkPrice =
            exitPrice !== undefined && !isNaN(exitPrice)
              ? exitPrice
              : !isNaN(markPrice)
                ? markPrice
                : entryPrice;




          // PnL calculation
          const pnl =
            entryPrice > 0 && size > 0
              ? exitPrice
                ? mathjs.round(
                  mathjs.multiply(
                    (exitPrice - entryPrice) * sideMultiplier,
                    size,
                  ),
                  8,
                )
                : mathjs.round(
                  mathjs.multiply(
                    (effectiveMarkPrice - entryPrice) * sideMultiplier,
                    size,
                  ),
                  8,
                )
              : 0;

          // PnL Percentage calculation
          const pnlPercentage =
            margin > 0
              ? mathjs.round(
                mathjs.multiply(mathjs.divide(pnl, margin), 100),
                2,
              )
              : 0;

          // ROI calculation
          const roi =
            margin > 0
              ? mathjs.round(
                mathjs.multiply(mathjs.divide(pnl, margin), 100),
                2,
              )
              : 0;

          // Margin ratio calculation
          const marginRatio =
            notional > 0
              ? mathjs.round(
                mathjs.multiply(mathjs.divide(margin, notional), 100),
                2,
              )
              : 0;

          // Update performance metrics for each trade
          if (pnl > 0) {
            performanceMetrics.totalWins++;
            performanceMetrics.totalWinAmount += pnl;
            performanceMetrics.currentWinStreak++;
            performanceMetrics.currentLossStreak = 0;
          } else {
            performanceMetrics.totalLosses++;
            performanceMetrics.totalLossAmount += pnl;
            performanceMetrics.currentLossStreak++;
            performanceMetrics.currentWinStreak = 0;
          }

          // Update cumulative metrics
          performanceMetrics.numTrades++;
          performanceMetrics.profitLoss += pnl;

          // Calculate averages
          performanceMetrics.averageWin =
            performanceMetrics.totalWins > 0
              ? performanceMetrics.totalWinAmount / performanceMetrics.totalWins
              : 0;

          performanceMetrics.averageLoss =
            performanceMetrics.totalLosses > 0
              ? Math.abs(
                performanceMetrics.totalLossAmount /
                performanceMetrics.totalLosses,
              )
              : 0;

          // Update win rate
          performanceMetrics.winRate =
            performanceMetrics.numTrades > 0
              ? (performanceMetrics.totalWins / performanceMetrics.numTrades) *
              100
              : 0;

          // Calculate risk-reward ratio
          performanceMetrics.riskRewardRatio =
            performanceMetrics.averageLoss > 0
              ? performanceMetrics.averageWin / performanceMetrics.averageLoss
              : 0;

          // Update profit factor
          performanceMetrics.profitFactor =
            Math.abs(performanceMetrics.totalLossAmount) > 0
              ? performanceMetrics.totalWinAmount /
              Math.abs(performanceMetrics.totalLossAmount)
              : performanceMetrics.totalWinAmount > 0
                ? Infinity
                : 0;

          // Update drawdown metrics
          const cumulativeProfit = performanceMetrics.profitLoss;
          performanceMetrics.currentDrawdown = Math.min(
            performanceMetrics.currentDrawdown,
            cumulativeProfit,
          );
          performanceMetrics.maxDrawdown = Math.min(
            performanceMetrics.maxDrawdown,
            performanceMetrics.currentDrawdown,
          );

          // Update streak metrics
          performanceMetrics.longestWinStreak = Math.max(
            performanceMetrics.longestWinStreak,
            performanceMetrics.currentWinStreak,
          );
          performanceMetrics.longestLossStreak = Math.max(
            performanceMetrics.longestLossStreak,
            performanceMetrics.currentLossStreak,
          );

          // Calculate Sharpe Ratio (annualized returns over standard deviation)
          const meanReturn =
            performanceMetrics.numTrades > 0
              ? performanceMetrics.profitLoss / performanceMetrics.numTrades
              : 0;

          const returnDeviation =
            performanceMetrics.numTrades > 0
              ? Math.sqrt(
                performanceMetrics.numTrades
                  ? performanceMetrics.profitLoss ** 2 /
                  performanceMetrics.numTrades
                  : 0,
              )
              : 0;

          performanceMetrics.sharpeRatio =
            returnDeviation > 0 ? meanReturn / returnDeviation : 0;

          // Calculate Sortino Ratio (using only downside deviation)
          const downsideDeviation =
            performanceMetrics.numTrades > 0
              ? Math.sqrt(
                performanceMetrics.numTrades
                  ? Math.min(performanceMetrics.profitLoss, 0) ** 2 /
                  performanceMetrics.numTrades
                  : 0,
              )
              : 0;

          performanceMetrics.sortinoRatio =
            downsideDeviation > 0 ? meanReturn / downsideDeviation : 0;

          // Add consistency score (ratio of win streaks to loss streaks)
          performanceMetrics.consistencyScore =
            performanceMetrics.longestLossStreak > 0
              ? performanceMetrics.longestWinStreak /
              performanceMetrics.longestLossStreak
              : performanceMetrics.longestWinStreak > 0
                ? Infinity
                : 0;



          if (activeOrder && activeOrder.id === order.id) {
            // Check PnL percentage and decide to close
            if (pnlPercentage >= targetPnl) {
              console.log(
                `Closing position for ${symbol}. PnL reached ${pnlPercentage}%`
              );
              // Add your close position logic here
              await closePosition(markPrice); // Replace with your method to close the position
            } else if (pnlPercentage <= -100) {
              logMessage("info", `>>> StopLoss Negative PnL% Detected <<<`);
              logMessage("info", `Closing position at mark price: ${markPrice.toFixed(8)}`);

              try {
                await closePosition(markPrice);
                activeOrder = undefined; // Clear active order
                logMessage("green", `SUCCESS: Position closed. Ready to re-invest.`);
              } catch (error) {
                logMessage("red", `ERROR: Could not close position. Reason: ${error.message}`);
              }
            } else {
              console.log(
                `PnL for ${symbol} is ${pnlPercentage}%, below target of ${targetPnl}%`
              );
            }
          }

          return {
            index: chalk.dim(`${index}`),
            side: chalk.magenta(`${order.side?.toUpperCase()}`),
            symbol: chalk.magenta(`${order.symbol?.toUpperCase()}`),
            time: chalk.gray(
              `${moment(order.entryTimestamp).format("Do, h:mm a")} [${moment
                .utc(
                  moment
                    .duration(Date.now() - order.entryTimestamp)
                    .as("milliseconds"),
                )
                .format("h[h] m[m] s[s]")} ago]`,
            ),
            tPPnlPercentage: chalk[takeProfitPnlPercentage > 0 ? "green" : "red"](`${takeProfitPnlPercentage}%`),
            size: chalk.yellow(`${size} units`),
            entryPrice: chalk.blue(`${entryPrice}`),
            margin: chalk.dim(`${humanizeNumber(margin)} USDT`),
            notional: chalk.blue(`${humanizeNumber(notional)}`),
            leverage: chalk.dim(`${humanizeNumber(leverage)}`),
            stopPrice: chalk.blue(`${takeProfit?.toFixed(8)}`),
            exitPrice: exitPrice
              ? chalk.blue(`${exitPrice}`)
              : chalk.green(`Open`),
            stopPnl: stopLossPnl,
            marginRatio: chalk.dim(`${marginRatio}%`),
            pnlPercentage: chalk[pnlPercentage > 0 ? "green" : "red"](`${pnlPercentage}%`),
            pnl: chalk[pnl > 0 ? "green" : "red"](`${humanizeNumber(pnl)} ${humanizeNumber(pnl * 130)}`),
            roi: chalk[roi > 0 ? "green" : "red"](`${roi}%`),
            duration: chalk.gray(
              exitPrice
                ? moment
                  .utc(
                    moment
                      .duration(order.exitTimestamp - order.entryTimestamp)
                      .as("milliseconds"),
                  )
                  .format("H[h] m[m] s[s]")
                : moment
                  .utc(
                    moment
                      .duration(Date.now() - order.entryTimestamp)
                      .as("milliseconds"),
                  )
                  .format("H[h] m[m] s[s]"),
            ),
            status: exitPrice
              ? pnl > 0
                ? chalk.blue("Profitable")
                : chalk.red("Loss")
              : chalk.green("Open"),
            // buyTSummary: `vDiff: ${humanizeNumber(absoluteVolumeDifference)}, VolVel: ${humanizeNumber(volumeVelocity)}, VelThresh: ${humanizeNumber(velocityThreshold)}, BuyVol: ${humanizeNumber(buyVolume)}, SellVol: ${humanizeNumber(sellVolume)}`.trim(),
            // sellTSummary: !exitPrice ? "" : `vDiff: ${humanizeNumber(closeSummary.absoluteVolumeDifference)}, VolVel: ${humanizeNumber(closeSummary.volumeVelocity)}, VelThresh: ${humanizeNumber(closeSummary.velocityThreshold)}, BuyVol: ${humanizeNumber(closeSummary.buyVolume)}, SellVol: ${humanizeNumber(closeSummary.sellVolume)}`.trim()
          };
        }));

      const table = chalkTable(tableOptions, tableData);
      console.log(table);
      // session.orders = orders;
      session.lastActionTime = lastActionTime;
      logPerformanceMetrics(performanceMetrics);

      // }
    // } catch (err) {
    //   console.error(chalk.red(`Error during iteration:`, err));
    // }
  }, 5000);
}

function gracefulShutdown() {
  console.log("Process is exiting... Saving session.");
  try {
    saveSession();
    console.log("Session saved successfully.");
  } catch (error) {
    console.error("Error saving session during shutdown:", error.message);
  }
}

// Catching process exit events
process.on("exit", gracefulShutdown); // For normal exit
process.on("SIGINT", () => {
  console.log("Caught SIGINT. Exiting gracefully...");
  gracefulShutdown();
  process.exit(0); // Ensure the process terminates after cleanup
});
process.on("SIGTERM", () => {
  console.log("Caught SIGTERM. Exiting gracefully...");
  gracefulShutdown();
  process.exit(0);
});
// process.on("uncaughtException", (err) => {
//   console.error("Uncaught exception occurred:", err.message);
//   console.error(err.stack);
//   gracefulShutdown();
//   process.exit(1); // Exit with an error code
// });


main();
