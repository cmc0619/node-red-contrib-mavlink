'use strict';

const resolve = require('./resolve');
const dialect = require('./dialect');
const delivery = require('./delivery-context');

module.exports = {
  ...resolve,
  ...dialect,
  ...delivery,
};
