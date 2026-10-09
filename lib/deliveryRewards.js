/* eslint-disable no-underscore-dangle */
const wait = require('util').promisify(setTimeout);

const WINDOW_TIMEOUT_MS = 10000;
const MENU_SETTLE_MS = 1000;

function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(entry => collectStrings(entry, output));
    return;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(key => collectStrings(value[key], output));
  }
}

function itemText(item) {
  const parts = [item.name, item.displayName].filter(Boolean);
  collectStrings(item.nbt, parts);
  return parts.join(' ')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getMenuItems(window) {
  const end = Number.isInteger(window.inventoryStart)
    ? window.inventoryStart
    : window.slots.length;
  return window.slots.slice(0, end);
}

function matchingSlots(window, predicate) {
  return getMenuItems(window)
    .reduce((matches, item, slot) => {
      if (item && predicate(item, itemText(item))) {
        matches.push(slot);
      }
      return matches;
    }, []);
}

function requireSingleSlot(window, predicate, description) {
  const matches = matchingSlots(window, predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${description} menu item, found ${matches.length}; no click was sent.`,
    );
  }
  return matches[0];
}

function isCoinExperienceReward(item, text) {
  return text.includes('daily reward')
    && text.includes('arcade')
    && text.includes('coin')
    && (text.includes('experience') || /\bexp\b/.test(text))
    && (item.name || '').toLowerCase().includes('minecart');
}

function isDailyCardIcon(item, text) {
  const name = (item.name || '').toLowerCase();
  const isRewardBlock = name === 'diamond_block'
    || name === 'gold_block'
    || text.includes('diamond block')
    || text.includes('gold block');
  return isRewardBlock && text.includes('daily reward');
}

function isClaimButton(item, text) {
  return text.includes('click to claim');
}

function logWindow(logger, window, label) {
  const items = getMenuItems(window)
    .map((item, slot) => (item ? {
      slot,
      name: item.name,
      displayName: item.displayName,
      text: itemText(item),
    } : null))
    .filter(Boolean);
  logger.info(`[delivery] ${label}: ${JSON.stringify({
    windowId: window.id,
    title: window.title,
    items,
  })}`);
}

function waitForWindowOpen(bot, logger, timeoutMs = WINDOW_TIMEOUT_MS) {
  if (bot.currentWindow) {
    return Promise.resolve(bot.currentWindow);
  }
  return new Promise((resolve, reject) => {
    let confirmationSent = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      bot.removeListener('windowOpen', onOpen);
      bot.removeListener('message', onMessage);
    };
    const onOpen = (window) => {
      cleanup();
      resolve(window);
    };
    const onMessage = (message) => {
      if (!confirmationSent && /type \/delivery again to confirm/i.test(message.toString())) {
        confirmationSent = true;
        logger.info('[delivery] Confirming the lobby transfer once.');
        bot.chat('/delivery');
      }
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for the Delivery Man menu.`));
    }, timeoutMs);
    bot.once('windowOpen', onOpen);
    bot.on('message', onMessage);
  });
}

async function openDeliveryMenu(bot, logger) {
  if (bot.currentWindow) {
    bot.closeWindow(bot.currentWindow);
  }
  const windowPromise = waitForWindowOpen(bot, logger);
  bot.chat('/delivery');
  return windowPromise;
}

function traceWindowClickPackets(bot, logger, enabled) {
  if (!enabled) {
    return () => {};
  }

  const client = bot._client;
  const originalWrite = client.write;
  const tracedWrite = function tracedWrite(name, params) {
    if (name === 'window_click') {
      logger.info(`[delivery] OUT ${name}: ${JSON.stringify(params)}`);
    }
    return originalWrite.call(this, name, params);
  };
  client.write = tracedWrite;

  return () => {
    if (client.write === tracedWrite) {
      client.write = originalWrite;
    }
  };
}

async function clickDeliveryRewards(bot, logger, tracePackets = true) {
  const restorePacketTrace = traceWindowClickPackets(bot, logger, tracePackets);
  try {
    let window = await openDeliveryMenu(bot, logger);
    logWindow(logger, window, 'Delivery Man menu');

    const coinRewardSlot = requireSingleSlot(
      window,
      isCoinExperienceReward,
      'Arcade coins and Hypixel Experience reward',
    );
    logger.info(`[delivery] Clicking coins/experience reward once at slot ${coinRewardSlot}.`);
    await bot.clickWindow(coinRewardSlot, 0, 0);
    await wait(MENU_SETTLE_MS);

    window = bot.currentWindow;
    let dailySlots = window ? matchingSlots(window, isDailyCardIcon) : [];
    if (dailySlots.length === 0) {
      window = await openDeliveryMenu(bot, logger);
      logWindow(logger, window, 'reopened Delivery Man menu');
      dailySlots = matchingSlots(window, isDailyCardIcon);
    }
    if (dailySlots.length !== 1) {
      const result = `Expected one daily reward block, found ${dailySlots.length}`;
      throw new Error(`${result}; no daily-reward click was sent.`);
    }

    const dailyRewardSlot = dailySlots[0];
    logger.info(`[delivery] Clicking daily reward block once at slot ${dailyRewardSlot}.`);
    await bot.clickWindow(dailyRewardSlot, 0, 0);
    await wait(MENU_SETTLE_MS);

    window = bot.currentWindow;
    if (window) {
      logWindow(logger, window, 'menu after daily reward click');
      const claimSlots = matchingSlots(window, isClaimButton);
      if (claimSlots.length === 1) {
        logger.info(
          `[delivery] Clicking visible CLICK TO CLAIM button once at slot ${claimSlots[0]}.`,
        );
        await bot.clickWindow(claimSlots[0], 0, 0);
        logger.info(
          '[delivery] Claim button clicked once; finish any browser/ad/card step manually.',
        );
      } else if (claimSlots.length > 1) {
        logger.warn(
          `[delivery] Found ${claimSlots.length} possible claim buttons; none was clicked.`,
        );
      } else {
        logger.info(
          '[delivery] No CLICK TO CLAIM button was visible; daily icon clicked once.',
        );
      }
    } else {
      logger.info('[delivery] Daily reward icon was clicked once; no follow-up window was opened.');
    }
  } finally {
    restorePacketTrace();
  }
}

module.exports = {
  clickDeliveryRewards,
  itemText,
  matchingSlots,
  requireSingleSlot,
};
