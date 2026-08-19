// credentialStore.js
// Persists Kodi connection details to disk so you don't have to retype
// them every session. The password is encrypted via Electron's
// built-in safeStorage module before writing — never stored as plain
// text. No extra dependency needed (unlike the older, now-unmaintained
// `keytar` package some guides still recommend).
//
// IMPORTANT CAVEAT, worth understanding rather than trusting blindly:
// safeStorage's actual protection level depends entirely on the OS.
//  - macOS: real Keychain-backed encryption.
//  - Windows: real DPAPI-backed encryption, tied to your Windows account.
//  - Linux: real encryption ONLY if a secret-service provider (GNOME
//    Keyring, KWallet) is actually running. If none is available —
//    common on minimal setups, VMs, or anything running as root
//    without a desktop keyring daemon (worth knowing given testing has
//    been happening on a Kali VM) — Electron silently falls back to a
//    scheme that encrypts with a hardcoded key baked into Chromium's
//    own source code. That's barely better than plaintext: it's
//    "encrypted" using a publicly-known constant, so anyone who gets
//    the file and knows this (now public) detail can decrypt it
//    trivially. This code detects that fallback and REFUSES to save
//    under it rather than silently pretending it's secure.

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');

function configPath() {
  return path.join(app.getPath('userData'), 'kodi-credentials.json');
}

async function saveKodiCredentials({ host, port, username, password }) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'No OS-level credential encryption is available on this system ' +
      '(no keychain/keyring found) — refusing to save the password ' +
      'insecurely. You can still connect each session without saving.'
    );
  }

  // getSelectedStorageBackend() is Linux-only; other platforms don't
  // have this concept, so guard for it existing before calling it.
  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text') {
      throw new Error(
        'This system has no real OS keyring available (no GNOME ' +
        'Keyring/KWallet running) — the only fallback encryption here ' +
        'uses a publicly-known key and would not actually protect the ' +
        'password. Refusing to save it. You can still connect each ' +
        'session without saving, or set up a keyring service (e.g. ' +
        'gnome-keyring) on this machine if you want persistence here.'
      );
    }
  }

  const encryptedPassword = safeStorage.encryptString(password || '').toString('hex');
  const data = { host, port, username, encryptedPassword };

  // mode: 0o600 restricts the file to owner read/write on Linux/macOS —
  // meaningless on Windows (NTFS permissions work differently there)
  // but harmless to include, and a real extra layer on the platform
  // where the weak-fallback risk above actually lives.
  fs.writeFileSync(configPath(), JSON.stringify(data), { mode: 0o600 });
}

function loadKodiCredentials() {
  const file = configPath();
  if (!fs.existsSync(file)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const password = data.encryptedPassword
      ? safeStorage.decryptString(Buffer.from(data.encryptedPassword, 'hex'))
      : '';
    return { host: data.host, port: data.port, username: data.username, password };
  } catch (err) {
    // Corrupted file, or encrypted on a different machine/OS user
    // (safeStorage's keys aren't portable) — just don't prefill rather
    // than crash the app over a stale credentials file.
    console.error('[credentialStore] failed to load/decrypt saved Kodi credentials:', err.message);
    return null;
  }
}

function clearKodiCredentials() {
  const file = configPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { saveKodiCredentials, loadKodiCredentials, clearKodiCredentials };
