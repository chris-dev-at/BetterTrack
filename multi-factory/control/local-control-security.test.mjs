import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedRequestHost,
  isLoopbackSource,
  isPrivateSource,
  isSameLoopbackOrigin,
  isSamePrivateOrigin,
} from './local-control-security.mjs';

test('control requests accept only loopback/private or explicitly configured hosts', () => {
  for (const host of [
    'localhost:8790',
    '127.0.0.1:8790',
    '[::1]:8790',
    '192.168.1.20:8790',
    '10.1.2.3:8790',
  ]) {
    assert.equal(isAllowedRequestHost(host, '0.0.0.0'), true, host);
  }
  assert.equal(isAllowedRequestHost('factory.internal:8790', 'factory.internal'), true);
  assert.equal(isAllowedRequestHost('attacker.example:8790', '0.0.0.0'), false);
  assert.equal(isAllowedRequestHost('127.0.0.1.attacker.example:8790', '0.0.0.0'), false);
  assert.equal(isAllowedRequestHost('', '127.0.0.1'), false);
});

test('credential mutations require a loopback socket and loopback same origin', () => {
  assert.equal(isLoopbackSource('127.0.0.1'), true);
  assert.equal(isLoopbackSource('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackSource('192.168.1.20'), false);

  assert.equal(
    isSameLoopbackOrigin({
      host: 'localhost:8790',
      origin: 'http://localhost:8790',
    }),
    true,
  );
  assert.equal(isSameLoopbackOrigin({ host: '127.0.0.1:8790' }), true);
  assert.equal(
    isSameLoopbackOrigin({
      host: 'localhost:8790',
      origin: 'http://attacker.example:8790',
    }),
    false,
  );
  assert.equal(
    isSameLoopbackOrigin({
      host: 'attacker.example:8790',
      origin: 'http://attacker.example:8790',
    }),
    false,
  );
  assert.equal(
    isSameLoopbackOrigin({
      host: '127.0.0.1.attacker.example:8790',
      origin: 'http://127.0.0.1.attacker.example:8790',
    }),
    false,
  );
});

test('LAN credential mutations require an exact private same origin', () => {
  assert.equal(
    isSamePrivateOrigin({
      host: '10.0.0.4:8790',
      origin: 'http://10.0.0.4:8790',
    }),
    true,
  );
  assert.equal(
    isSamePrivateOrigin({
      host: '192.168.1.20:8790',
      origin: 'https://192.168.1.20:8790',
    }),
    false,
  );
  assert.equal(
    isSamePrivateOrigin({
      host: '10.0.0.4:8790',
      origin: 'http://10.0.0.5:8790',
    }),
    false,
  );
  assert.equal(
    isSamePrivateOrigin({
      host: '10.0.0.4:8790',
      origin: 'http://attacker.example:8790',
    }),
    false,
  );
  assert.equal(isSamePrivateOrigin({ host: '10.0.0.4:8790' }), false);
  assert.equal(
    isSamePrivateOrigin({
      host: 'attacker.example:8790',
      origin: 'http://attacker.example:8790',
    }),
    false,
  );
});

test('socket source guard rejects public addresses', () => {
  assert.equal(isPrivateSource('::1'), true);
  assert.equal(isPrivateSource('172.20.0.4'), true);
  assert.equal(isPrivateSource('8.8.8.8'), false);
  assert.equal(isPrivateSource('203.0.113.9'), false);
});
