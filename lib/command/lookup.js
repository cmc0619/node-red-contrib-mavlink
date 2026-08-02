'use strict';

/**
 * Find one MAV_CMD definition by its numeric value.
 *
 * @param {object} bundle
 * @param {number} commandId
 * @returns {object|null}
 */
function commandByValue(bundle, commandId) {
  if (!bundle) return null;
  return Object.values(bundle.commands || {}).find(
    (command) => Number(command.value) === Number(commandId)
  ) || null;
}

module.exports = { commandByValue };
