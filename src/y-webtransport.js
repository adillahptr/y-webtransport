/**
 * @module provider/websocket
 */

/* eslint-env browser */

import * as Y from 'yjs' // eslint-disable-line
import * as bc from 'lib0/broadcastchannel'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as authProtocol from 'y-protocols/auth'
import * as awarenessProtocol from 'y-protocols/awareness'
import { Observable } from 'lib0/observable'
import * as math from 'lib0/math'
import * as url from 'lib0/url'
import * as io from 'socket.io-client'

export const messageSync = 0
export const messageQueryAwareness = 3
export const messageAwareness = 1
export const messageAuth = 2
export const customMessage = 4

/**
 *                       encoder,          decoder,          provider,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketProvider, boolean,    number):void>}
 */
const messageHandlers = [];

messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageSync);
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    provider.doc,
    provider
  );
  if (
    emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 &&
    !provider.synced
  ) {
    provider.synced = true;
  }
};

messageHandlers[messageQueryAwareness] = (
  encoder,
  _decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(
      provider.awareness,
      Array.from(provider.awareness.getStates().keys())
    )
  );
};

messageHandlers[messageAwareness] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  awarenessProtocol.applyAwarenessUpdate(
    provider.awareness,
    decoding.readVarUint8Array(decoder),
    provider
  );
};

messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  authProtocol.readAuthMessage(
    decoder,
    provider.doc,
    (_ydoc, reason) => permissionDeniedHandler(provider, reason)
  );
};

messageHandlers[customMessage] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  provider.emit('custom-message', [decoding.readVarString(decoder)]);
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

/**
 * @param {WebtransportProvider} provider
 * @param {string} reason
 */
const permissionDeniedHandler = (provider, reason) =>
  console.warn(`Permission denied to access ${provider.url}.\n${reason}`);

/**
 * @param {WebtransportProvider} provider
 * @param {Uint8Array} buf
 * @param {boolean} emitSynced
 * @return {encoding.Encoder}
 */
const readMessage = (provider, buf, emitSynced) => {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  const messageHandler = provider.messageHandlers[messageType];
  if (/** @type {any} */ (messageHandler)) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType);
  } else {
    console.error('Unable to compute message');
  }
  return encoder
};

/**
 * @param {WebtransportProvider} provider
 */
const setupWS = (provider) => {
  if (provider.shouldConnect && provider.socket === null) {
    const socket = provider._Socket(provider.serverUrl, {
      transportOptions: {
        webtransport: {
          hostname: "127.0.0.1",
          port: "3000"
        }
      },
      rejectUnauthorized: false,
      query: `roomname=${provider.roomname}`,
    });

    socket.binaryType = 'arraybuffer';
    provider.socket = socket;
    provider.socketconnecting = true;
    provider.socketconnected = false;
    provider.synced = false;

    socket.on('message', (message) => {
      provider.socketLastMessageReceived = time.getUnixTime();
      const encoder = readMessage(provider, new Uint8Array(message), true);
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
    });

    socket.on('error', (event) => {
      provider.emit('connection-error', [event, provider]);
    });

    socket.on('disconnect', (event) => {
      provider.emit('connection-close', [event, provider]);
      provider.socket = null;
      provider.socketconnecting = false;
      if (provider.socketconnected) {
        provider.socketconnected = false;
        provider.synced = false;
        // update awareness (all users except local left)
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter((client) =>
            client !== provider.doc.clientID
          ),
          provider
        );
        provider.emit('status', [{
          status: 'disconnected'
        }]);
      } else {
        provider.socketUnsuccessfulReconnects++;
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.socketUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      );
    });

    socket.on('connect', () => {
      provider.socketLastMessageReceived = time.getUnixTime();
      provider.socketconnecting = false;
      provider.socketconnected = true;
      provider.socketUnsuccessfulReconnects = 0;
      provider.emit('status', [{
        status: 'connected'
      }]);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, provider.doc);
      socket.send(encoding.toUint8Array(encoder));

      if (provider.awareness.getLocalState() !== null) {
        const encoderAwarenessState = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessState, messageAwareness);
        encoding.writeVarUint8Array(
          encoderAwarenessState,
          awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
            provider.doc.clientID
          ])
        );
        socket.send(encoding.toUint8Array(encoderAwarenessState));
      }
    });

    provider.emit('status', [{
      status: 'connecting'
    }]);
  }
};

/**
 * @param {WebtransportProvider} provider
 * @param {ArrayBuffer} buf
 */
const broadcastMessage = (provider, buf) => {
  if (provider.socketconnected) {
    /** @type {Socket} */ (provider.socket).send(buf);
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider);
  }
};

/**
 * Webtransport Provider for Yjs. Creates a webtransport connection using socket.io and @fails-component/webtransport
 * to sync the shared document. The code is modified from Yjs y-websocket.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to https://127.0.0.1:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebtransportProvider } from 'y-webtransport'
 *   const doc = new Y.Doc()
 *   const provider = new WebtransportProvider('https://127.0.0.1:1234', 'my-document-name', doc)
 *
 * @extends {Observable<string>}
 */
export class WebsocketProvider extends Observable {
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {object} [opts]
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string,string>} [opts.params]
   * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
   * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
   * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
   * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
   */
  constructor (serverUrl, roomname, doc, {
    connect = true,
    awareness = new awarenessProtocol.Awareness(doc),
    params = {},
    resyncInterval = -1,
    maxBackoffTime = 2500,
    disableBc = false
  } = {}) {
    super();
    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === '/') {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    const encodedParams = url.encodeQueryParams(params);
    this.maxBackoffTime = maxBackoffTime;
    this.bcChannel = serverUrl + '/' + roomname;
    this.serverUrl = serverUrl;
    this.url = serverUrl + '/' + roomname +
      (encodedParams.length === 0 ? '' : '?' + encodedParams);
    this.roomname = roomname;
    this.doc = doc;
    this._Socket = io;
    this.awareness = awareness;
    this.socketconnected = false;
    this.socketconnecting = false;
    this.bcconnected = false;
    this.disableBc = disableBc;
    this.socketUnsuccessfulReconnects = 0;
    this.messageHandlers = messageHandlers.slice();
    /**
     * @type {boolean}
     */
    this._synced = false;
    /**
     * @type {Socket?}
     */
    this.socket = null;
    this.socketLastMessageReceived = 0;
    /**
     * Whether to connect to other peers or not
     * @type {boolean}
     */
    this.shouldConnect = connect;

    /**
     * Send a message to a specific user
     * @param target the target id
     * @param message the message
     */
    this.sendToUser = (target, message) => {
      if (this.socket && this.socket.connected) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, customMessage);
        encoding.writeVarString(encoder, target);
        encoding.writeVarString(encoder, message);
        this.socket.send(encoding.toUint8Array(encoder));
      }
    };

    /**
     * @type {number}
     */
    this._resyncInterval = 0;
    if (resyncInterval > 0) {
      this._resyncInterval = /** @type {any} */ (setInterval(() => {
        if (this.socket && this.socket.connected) {
          // resend sync step 1
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.writeSyncStep1(encoder, doc);
          this.socket.send(encoding.toUint8Array(encoder));
        }
      }, resyncInterval));
    }

    /**
     * @param {ArrayBuffer} data
     * @param {any} origin
     */
    this._bcSubscriber = (data, origin) => {
      if (origin !== this) {
        const encoder = readMessage(this, new Uint8Array(data), false);
        if (encoding.length(encoder) > 1) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this);
        }
      }
    };
    /**
     * Listens to Yjs updates and sends them to remote peers (socket and broadcastchannel)
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        broadcastMessage(this, encoding.toUint8Array(encoder));
      }
    };
    this.doc.on('update', this._updateHandler);
    /**
     * @param {any} changed
     * @param {any} _origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      );
      broadcastMessage(this, encoding.toUint8Array(encoder));
    };
    this._unloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        'window unload'
      );
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('unload', this._unloadHandler);
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._unloadHandler);
    }
    awareness.on('update', this._awarenessUpdateHandler);
    this._checkInterval = /** @type {any} */ (setInterval(() => {
      if (
        this.socketconnected &&
        messageReconnectTimeout <
        time.getUnixTime() - this.socketLastMessageReceived
      ) {
        // no message received in a long time - not even your own awareness
        // updates (which are updated every 15 seconds)
        /** @type {Socket} */ 
        (this.socket).close();
      }
    }, messageReconnectTimeout / 10));
    if (connect) {
      this.connect();
    }
  }

  /**
   * @type {boolean}
   */
  get synced () {
    return this._synced
  }

  set synced (state) {
    if (this._synced !== state) {
      this._synced = state;
      this.emit('synced', [state]);
      this.emit('sync', [state]);
    }
  }

  destroy () {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval);
    }
    clearInterval(this._checkInterval);
    this.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('unload', this._unloadHandler);
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._unloadHandler);
    }
    this.awareness.off('update', this._awarenessUpdateHandler);
    this.doc.off('update', this._updateHandler);
    super.destroy();
  }

  connectBc () {
    if (this.disableBc) {
      return
    }
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber);
      this.bcconnected = true;
    }
    // send sync step1 to bc
    // write sync step 1
    const encoderSync = encoding.createEncoder();
    encoding.writeVarUint(encoderSync, messageSync);
    syncProtocol.writeSyncStep1(encoderSync, this.doc);
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
    // broadcast local state
    const encoderState = encoding.createEncoder();
    encoding.writeVarUint(encoderState, messageSync);
    syncProtocol.writeSyncStep2(encoderState, this.doc);
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    );
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessState, messageAwareness);
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ])
    );
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    );
  }

  disconnectBc () {
    // broadcast message with local awareness state set to null (indicating disconnect)
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ], new Map())
    );
    broadcastMessage(this, encoding.toUint8Array(encoder));
    if (this.bcconnected) {
      bc.unsubscribe(this.bcChannel, this._bcSubscriber);
      this.bcconnected = false;
    }
  }

  disconnect () {
    this.shouldConnect = false;
    this.disconnectBc();
    if (this.socket !== null) {
      this.socket.close();
    }
  }

  connect () {
    this.shouldConnect = true;
    if (!this.socketconnected && this.socket === null) {
      setupWS(this);
      this.connectBc();
    }
  }
}
