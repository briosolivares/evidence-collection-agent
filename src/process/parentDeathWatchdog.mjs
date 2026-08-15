const PROTOCOL_VERSION = 1;

let targetProcessGroupId;
let terminating = false;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function send(message, callback) {
  if (typeof process.send !== 'function' || !process.connected) {
    callback?.(new Error('watchdog IPC channel is closed'));
    return;
  }
  try {
    process.send(message, callback);
  } catch (error) {
    callback?.(error);
  }
}

function signalTarget(signal) {
  if (targetProcessGroupId === undefined) return;
  try {
    process.kill(-targetProcessGroupId, signal);
  } catch {
    // The process group has already exited, which is the desired state.
  }
}

function terminateTargetAfterParentDeath() {
  if (terminating) return;
  terminating = true;

  if (targetProcessGroupId === undefined) {
    process.exit(0);
    return;
  }

  // The harness process is already gone, so there is nobody left to perform
  // an orderly shutdown or hold the run lock. A grace interval here would let
  // a SIGTERM-resistant old effect overlap immediate crash recovery in the
  // replacement coordinator. Hard-kill the complete process group before
  // exiting the independent supervisor.
  signalTarget('SIGKILL');
  process.exit(0);
}

process.on('message', (message) => {
  if (
    !isRecord(message) ||
    message.version !== PROTOCOL_VERSION ||
    typeof message.kind !== 'string'
  ) {
    process.disconnect();
    process.exitCode = 1;
    return;
  }

  if (message.kind === 'arm') {
    if (
      targetProcessGroupId !== undefined ||
      !Number.isSafeInteger(message.processGroupId) ||
      message.processGroupId <= 1 ||
      message.processGroupId === process.pid
    ) {
      process.disconnect();
      process.exitCode = 1;
      return;
    }
    targetProcessGroupId = message.processGroupId;
    send({ version: PROTOCOL_VERSION, kind: 'armed' });
    return;
  }

  if (message.kind === 'disarm') {
    targetProcessGroupId = undefined;
    send({ version: PROTOCOL_VERSION, kind: 'disarmed' }, () => {
      if (process.connected) process.disconnect();
      process.exitCode = 0;
    });
    return;
  }

  process.disconnect();
  process.exitCode = 1;
});

process.once('disconnect', terminateTargetAfterParentDeath);

send({ version: PROTOCOL_VERSION, kind: 'ready' });
