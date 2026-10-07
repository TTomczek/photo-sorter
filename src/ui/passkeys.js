(() => {
  function decodeBase64Url(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function encodeBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function creationOptions(options) {
    return {
      ...options,
      challenge: decodeBase64Url(options.challenge),
      user: { ...options.user, id: decodeBase64Url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
        ...credential,
        id: decodeBase64Url(credential.id),
      })),
    };
  }

  function requestOptions(options) {
    return {
      ...options,
      challenge: decodeBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((credential) => ({
        ...credential,
        id: decodeBase64Url(credential.id),
      })),
    };
  }

  async function serialize(credential) {
    const response = credential.response;
    const json = {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
    if (response.attestationObject) {
      json.response.attestationObject = encodeBase64Url(response.attestationObject);
      json.response.transports = response.getTransports?.() || [];
    }
    if (response.authenticatorData) {
      json.response.authenticatorData = encodeBase64Url(response.authenticatorData);
    }
    if (response.signature) json.response.signature = encodeBase64Url(response.signature);
    if (response.userHandle) json.response.userHandle = encodeBase64Url(response.userHandle);
    return json;
  }

  async function create(options) {
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    if (!credential) throw new Error('Passkey registration was cancelled.');
    return serialize(credential);
  }

  async function get(options) {
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
    if (!credential) throw new Error('Passkey sign-in was cancelled.');
    return serialize(credential);
  }

  window.photoSorterPasskeys = Object.freeze({ create, get });
})();
