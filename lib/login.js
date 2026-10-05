/* eslint comma-dangle: ["error", {"functions": "never"}] */
const request = require('request');
const os = require('os');
const packageJson = require('../package.json');
const util = require('../util/utility');
const logger = require('./logger');
const bigInt = require('big-integer');
const createHash = require('../util/createHash');
const Session = require('./session');
const { getTipCount } = require('./tracker');

const headers = {
  'User-Agent': `node-autotip@${packageJson.version}`
};

function getServerHash(uuid) {
  const salt = bigInt.randBetween('0', '1.3611295e39').toString(32);
  return createHash(uuid + salt);
}

function joinServer(params, cb) {
  const options = {
    url: 'https://sessionserver.mojang.com/session/minecraft/join',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  };
  request(options, (err, res) => {
    if (err) {
      return cb(err, null);
    }
    if (![200, 204].includes(res.statusCode)) {
      logger.error(`Error ${res.statusCode} during authentication: Session servers down?`);
      return cb(res.statusCode, null);
    }
    return cb(null, true);
  });
}

function autotipLogin(uuid, session, hash, cb) {
  getTipCount(uuid, (tipCount) => {
    request(
      {
        url: `https://autotip.sk1er.club/login?username=${session.selectedProfile.name}&uuid=${util.removeDashes(uuid)}&tips=${tipCount + 1}&v=3.2&mc=1.8.9&os=${os.type()}&hash=${hash}`,
        headers
      },
      (err, res, body) => {
        if (err) {
          const code = err.code ? ` (code ${err.code})` : '';
          return cb(new Error(`AutoTip login request failed${code}`), null);
        }
        if (!res || res.statusCode < 200 || res.statusCode >= 300) {
          const status = res ? res.statusCode : 'no response';
          return cb(new Error(`AutoTip login returned HTTP ${status}`), null);
        }
        return cb(null, body);
      }
    );
  });
}

function login(uuid, session, cb) {
  const { accessToken } = session;
  logger.debug(`Trying to log in as ${util.removeDashes(uuid)}`);

  const hash = getServerHash(util.removeDashes(uuid));

  joinServer({
    accessToken,
    selectedProfile: util.removeDashes(uuid),
    serverId: hash
  }, (err, success) => {
    if (success) {
      logger.debug('Successfully created Mojang session!');

      autotipLogin(uuid, session, hash, (loginErr, body) => {
        let json = {};
        if (loginErr) {
          logger.error(`Unable to login to AutoTip: ${loginErr.message || loginErr}`);
          return;
        }
        try {
          json = JSON.parse(body);
        } catch (e) {
          logger.warn('AutoTip login response was not valid JSON');
          throw new Error('AutoTip login returned invalid JSON');
        }
        if (!json.success) {
          logger.error('AutoTip login was rejected (response success was not true)');
          throw new Error('AutoTip login was rejected');
        }
        logger.info('AutoTip session established');
        cb(new Session(json));
      });
    }
  });
}

module.exports = login;
