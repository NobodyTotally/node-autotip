/* eslint-disable max-len, class-methods-use-this */
const packageJson = require('../package.json');
const logger = require('./logger');
const tipper = require('./tipper');
const request = require('request');

const headers = {
  'User-Agent': `node-autotip@${packageJson.version}`,
};

class Session {
  constructor(obj) {
    this.json = obj;

    this.sessionKey = obj.sessionKey;
    this.keepAliveRate = obj.keepAliveRate;
    this.tipWaveRate = obj.tipWaveRate;
    this.tipCycleRate = obj.tipCycleRate;

    this.sendTipRequest();
    this.keepAlive = setInterval(() => this.sendKeepAlive(), this.keepAliveRate * 1000);
    this.tipWave = setInterval(() => this.sendTipRequest(), this.tipWaveRate * 1000);
  }

  sendKeepAlive() {
    const key = this.sessionKey;
    request({
      url: `https://autotip.sk1er.club/keepalive?key=${key}`,
      headers,
    }, (err, res) => {
      if (err) {
        const code = err.code ? ` (code ${err.code})` : '';
        logger.error(`AutoTip keepalive request failed${code}`);
        return;
      }
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        const status = res ? res.statusCode : 'no response';
        logger.warn(`AutoTip keepalive returned HTTP ${status}`);
      } else {
        logger.info(`AutoTip keepalive returned HTTP ${res.statusCode}`);
      }
    });
  }

  sendTipRequest(games = []) {
    const key = this.sessionKey;
    request({
      url: `https://autotip.sk1er.club/tip?key=${key}`,
      headers,
    }, (err, res, body) => {
      if (err) {
        const code = err.code ? ` (code ${err.code})` : '';
        logger.error(`AutoTip queue request failed${code}`);
        return;
      }
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        const status = res ? res.statusCode : 'no response';
        logger.warn(`AutoTip queue request returned HTTP ${status}`);
        return;
      }

      let JSONbody = {};
      try {
        JSONbody = JSON.parse(body);
      } catch (e) {
        logger.warn(`AutoTip queue response was not valid JSON (HTTP ${res.statusCode})`);
        return;
      }
      if (!JSONbody.success) {
        logger.warn(`AutoTip queue response was unsuccessful (HTTP ${res.statusCode})`);
        return;
      }
      if (!Array.isArray(JSONbody.tips)) {
        logger.warn(`AutoTip queue response had no tips array (HTTP ${res.statusCode})`);
        return;
      }

      const queue = (games.length > 0
        ? JSONbody.tips.filter(tip => games.includes(tip.gamemode))
        : JSONbody.tips);
      logger.info(
        `AutoTip queue refresh succeeded (HTTP ${res.statusCode}); ${queue.length} target(s)`,
      );
      tipper.updateQueue(queue);
    });
  }

  logOut(cb) {
    request({
      url: `https://autotip.sk1er.club/logout?key=${this.sessionKey}`,
      headers,
    }, (err, res) => {
      if (err) {
        const code = err.code ? ` (code ${err.code})` : '';
        logger.error(`AutoTip logout request failed${code}`);
      } else if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        const status = res ? res.statusCode : 'no response';
        logger.warn(`AutoTip logout returned HTTP ${status}`);
      } else {
        logger.debug(`AutoTip logout returned HTTP ${res.statusCode}`);
      }
      cb();
    });
  }
}

module.exports = Session;
