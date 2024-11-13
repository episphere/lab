// import gunDB from './gunWrapper.js'
// import p2p from './yjsWrapper.js'

import { Doc, WebrtcProvider } from "https://cdn.jsdelivr.net/gh/rozek/yjs-bundle/dist/yjs-bundle.esm.js"

const DEFAULT_FEDERATION_NAME = "federation_x"
const PEERS_SHARED_ARRAY_NAME = "peers"
const MESSAGES_SHARED_ARRAY_NAME = "messages"
const PARAMETERS_SHARED_ARRAY_NAME = "parameters"

const EVENT_NAME_PREFIX = "webFed"

export class WebFed {
  constructor({ signalingServer = [], federationName = DEFAULT_FEDERATION_NAME, federationPassword = "", selfName, dataset, quorumThreshold = 1.0 }) {
    if (!signalingServer) {
      console.error("Please provide a valid URL to a signaling server.")
      return false
    }

    if (!selfName) {
      selfName = localStorage.webFed?.length > 0 ? JSON.parse(localStorage.webFed)?.selfName : window.crypto.randomUUID()
      localStorage.webFed = localStorage.webFed?.length > 0 ? JSON.stringify({
        ...JSON.parse(localStorage.webFed),
        selfName
      }) : JSON.stringify({
        selfName
      })
    }

    this.federationName = federationName

    this.quorumThreshold = quorumThreshold
    this.trainingParams = {
      dataset
    }

    const signalingServerURLs = Array.isArray(signalingServer) ? signalingServer : [signalingServer]
    this.signalingServerURLs = signalingServerURLs.map(signalingServerURL => {
      if (!signalingServerURL.startsWith("ws")) {
        if (signalingServerURL.startsWith("http")) {
          signalingServerURL = signalingServerURL.replace("https://", "")
          signalingServerURL = signalingServerURL.replace("http://", "")
        }
        signalingServerURL = signalingServerURL.includes("localhost") ? `ws://${signalingServerURL}` : `wss://${signalingServerURL}`
      }
      return signalingServerURL
    })

    this.yDoc = new Doc()
    this.peersSharedArray = this.yDoc.getArray(PEERS_SHARED_ARRAY_NAME)
    this.messagesSharedArray = this.yDoc.getArray(MESSAGES_SHARED_ARRAY_NAME)
    this.parametersSharedArray = this.yDoc.getArray(PARAMETERS_SHARED_ARRAY_NAME)

    this.provider = new WebrtcProvider(this.federationName, this.yDoc, {
      signaling: this.signalingServerURLs,
      password: federationPassword
    })

    this.provider.on('synced', (synced) => {
      const syncedEvent = new CustomEvent("webFed_synced", {
        detail: synced
      })
      document.dispatchEvent(syncedEvent)

      const previousInstance = this.getPeerInfo(selfName)
      if (previousInstance) {
        if (this.isPeerConnected(previousInstance.name)) {
          // NEED TO TEST!!!!
          console.error(`The name ${selfName} has already been taken. Please try connecting again with a different name!`)
          fed.provider.destroy()
          return
        }
        const previousInstanceIndex = this.getAllPeers().findIndex(peerObj => peerObj.name === selfName)
        this.peersSharedArray.delete(previousInstanceIndex, 1)
      }
      this.selfName = selfName // THIS SHOULD NOT HAPPEN HERE. WAITING FOR SELFNAME TO BE ASSIGNED MAKES SENSE TO PREVENT DUPLICATES, 
      // BUT IF THIS IS THE FIRST PEER, IT NEVER GETS ASSIGNED UNTIL ANOTHER ONE JOINS. COULD BE A RACE CONDITION AT THAT POINT. IF THIS
      // IS THE FIRST PEER, JUST ASSIGN SELFNAME DIRECTLY!!!!!
      
      this.peersSharedArray.push([{
        name: this.selfName,
        joinedAt: Date.now(),
        _webRTCPeerId: this.getSelfWebRTCPeerId()
      }])

      this.peersSharedArray.observe((event) => {
        // Handle delta calculation later
        const newPeerEvent = new CustomEvent("webFed_newPeer", {
          detail: event.changes.delta
        })
        document.dispatchEvent(newPeerEvent)
      })

      this.messagesSharedArray.observeDeep((event) => {
        this.messagesSharedArray.forEach(async (messageObj, index) => {

          if (!messageObj?.acknowledged?.includes(this.selfName)) {
            switch (messageObj.type) {
              case this.MESSAGE_TYPE_NAMES['claimInitiator']:
                const claimInitiatorEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['claimInitiator']}`, messageObj)
                document.dispatchEvent(claimInitiatorEvent)

                if (this.canClaimInitiatorStatus(messageObj.data.initiatedBy)) {
                  messageObj.acknowledged.push(this.selfName)
                } else {
                  messageObj['rejected'] = messageObj.rejected || []
                  messageObj.rejected.push(this.selfName)
                }
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break

              case this.MESSAGE_TYPE_NAMES['initialModelInfo']:
                if (messageObj.data) {
                  const { FedModel } = await import("./webFed_model.js")
                  this.model = new FedModel(messageObj.data)
                }

                const initialModelInfoReceivedEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['initialModelInfo']}`, {
                  detail: messageObj
                })
                document.dispatchEvent(initialModelInfoReceivedEvent)

                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])

                break

              case this.MESSAGE_TYPE_NAMES['trainingParams']:
                if (messageObj.data) {
                  const { data: trainingParams } = messageObj
                  this.trainingParams = {
                    ...this.trainingParams,
                    ...trainingParams
                  }
                }
                
                const trainingParamsEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['trainingParams']}`, {
                  detail: messageObj
                })
                document.dispatchEvent(trainingParamsEvent)
                
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                
                break

              case this.MESSAGE_TYPE_NAMES['startTraining']:
                const startTrainingEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['startTraining']}`, {
                  detail: messageObj
                })
                document.dispatchEvent(startTrainingEvent)
                this.startTraining()

                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])

                break
                
                case this.MESSAGE_TYPE_NAMES['stopTraining']:
                  this.stopRequested = true
                  const stopRequestedEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['stopTraining']}`, {
                    detail: messageObj
                  })
                  document.dispatchEvent(stopRequestedEvent)
                  
                  messageObj.acknowledged.push(this.selfName)
                  this.messagesSharedArray.delete(index, 1)
                  this.messagesSharedArray.insert(index, [messageObj])
                 
                  break
                
              default:
                console.log(messageObj)
                break
            }
          }
        })
      })

      this.parametersSharedArray.observeDeep((event) => {
        this.parametersSharedArray.forEach(async (update, index) => {
          if (!update.acknowledged.includes(this.selfName)) {
            switch(update.type) {
              case this.MESSAGE_TYPE_NAMES['roundComplete']:
                  const trainingRoundCompleteEvent = new CustomEvent(`${EVENT_NAME_PREFIX}_${this.MESSAGE_TYPE_NAMES['roundComplete']}`, {
                    detail: update
                  })
                  document.dispatchEvent(trainingRoundCompleteEvent)
                  
                  update.acknowledged.push(this.selfName)
                  this.messagesSharedArray.delete(index, 1)
                  this.messagesSharedArray.insert(index, [update])
                  break

              default:
                console.log("Params updated", update)
                break
            }
          }
        })
      })

    })

  }

  MESSAGE_TYPE_NAMES = {
    "claimInitiator": "claimInitiator",
    "initialModelInfo": "initialModelInfo",
    "trainingParams": "trainingParams",
    "startTraining": "startTraining",
    "roundComplete": "trainingRoundComplete",
    "stopTraining": "stopTraining"
  }

  reset() {
    localStorage.clear()
    this.provider.disconnect()
  }

  isConnected() {
    return this.provider.connected
  }

  isSynced() {
    // Returns undefined if room has not yet been created
    return this.provider.room?.synced
  }

  getSignalingServerURLs() {
    return this.signalingServerURLs
  }

  getFederationName() {
    return this.federationName
  }

  getSelfWebRTCPeerId() {
    return this.provider.room?.peerId
  }

  getSelfName() {
    return this.selfName
  }

  getAllPeers() {
    const peers = []
    this.peersSharedArray.forEach(peerObj => {
      const peer = {
        ...peerObj,
        'isSelf': peerObj.name === this.selfName && peerObj._webRTCPeerId === this.getSelfWebRTCPeerId(),
      }
      peers.push(peer)
    })
    return peers
  }

  getNumPeers() {
    return this.getAllPeers().length
  }

  getPeerInfo(peerName) {
    const peerInfo = this.getAllPeers().find(peerObj => peerObj.name === peerName)
    return peerInfo
  }

  isPeerConnected(peerName) {
    const peerInfo = this.getPeerInfo(peerName)
    const isPeerConnected = this._isWebRTCPeerConnected(peerInfo._webRTCPeerId)
    return isPeerConnected
  }

  isPeerSynced(peerName) {
    const peerInfo = this.getPeerInfo(peerName)
    const isPeerSynced = this._isWebRTCPeerSynced(peerInfo._webRTCPeerId)
    return isPeerSynced
  }

  getConnectedPeers() {
    const connectedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && this.isPeerConnected(peerObj.name))
    return connectedPeers
  }

  getDisconnectedPeers() {
    const disconnectedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && !this.isPeerConnected(peerObj.name))
    return disconnectedPeers
  }

  getSyncedPeers() {
    const syncedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && this.isPeerSynced(peerObj.name))
    return syncedPeers
  }

  getDesyncedPeers() {
    const desyncedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && !this.isPeerSynced(peerObj.name))
    return desyncedPeers
  }

  getMessages({
    messageType,
    fromPeerName,
    dataFilters = {}
  }) {
    const messagesOfRequestedType = []
    this.messagesSharedArray.forEach(async (messageObj, index) => {
      const messageOfCorrectType = typeof (messageType) !== 'undefined' ? messageObj.type === messageType : true
      const messageFromCorrectPeer = typeof (fromPeerName) !== 'undefined' ? messageObj.from === fromPeerName : true
      const messageSatisfiesDataFilters = Object.keys(dataFilters).length > 0 ? Object.entries(dataFilters).reduce((satisfied, [key, value]) => {
        if (messageObj.data?.[key] !== value) {
          satisfied = false
        }
        return satisfied
      }, true) : true
      if (messageOfCorrectType && messageFromCorrectPeer && messageSatisfiesDataFilters) {
        messagesOfRequestedType.push(messageObj)
      }
    })
    return messagesOfRequestedType
  }
  
  getParams({
    paramsType,
    fromPeerName,
    dataFilters = {}
  }) {
    const params = []
    this.parametersSharedArray.forEach(async (paramsObj, index) => {
      const paramsOfCorrectType = typeof (paramsType) !== 'undefined' ? paramsObj.type === paramsType : true
      const paramsFromCorrectPeer = typeof (fromPeerName) !== 'undefined' ? paramsObj.from === fromPeerName : true
      const paramsSatisfiesDataFilters = Object.keys(dataFilters).length > 0 ? Object.entries(dataFilters).reduce((satisfied, [key, value]) => {
        if (paramsObj.data?.[key] !== value) {
          satisfied = false
        }
        return satisfied
      }, true) : true
      if (paramsOfCorrectType && paramsFromCorrectPeer && paramsSatisfiesDataFilters) {
        params.push(paramsObj)
      }
    })
    return params
  }

  sendMessageToPeer(peerName, message) {
    const { _webRTCPeerId } = this.getPeerInfo(peerName)
    if (_webRTCPeerId) {
      this._sendMessageToWebRTCPeer(_webRTCPeerId, message)
    }
  }

  expectMessageFromPeer(peerName, callback) {
    const { _webRTCPeerId } = this.getPeerInfo(peerName)
    this._expectMessageFromWebRTCPeer(_webRTCPeerId, callback)
  }

  broadcastMessage(message) {
    this.messagesSharedArray.push([message])
  }
  
  broadcastParams(update) {
    this.parametersSharedArray.push([update])
  }

  checkQuorum(messageType) {
    let wasQuorumAchieved = false
    
    const messages = this.getMessages({
      messageType
    })
    messages.forEach(message => {
      if (message.acknowledged.length >= this.getNumPeers() * this.quorumThreshold) {
        wasQuorumAchieved = true
      }
    })
    return wasQuorumAchieved
  }

  awaitQuorum(messageType) {
    return new Promise((resolve, reject) => {
      const quorumChecker = setInterval(() => {
        console.log("Checking Quorum")
        if (this.checkQuorum(messageType)) {
          clearInterval(quorumChecker)
          resolve(true)
        }
      }, 1000)
    })
  }

  canClaimInitiatorStatus(name) {
    let canClaimInitiatorStatus = true
    
    const messages = this.getMessages({
      'messageType': this.MESSAGE_TYPE_NAMES['claimInitiator']
    })
    messages.forEach(message => {
      if (message.data.initiatedBy !== name && this.isPeerConnected(message.data.initiatedBy)) {
        canClaimInitiatorStatus = false
      }
    })
    
    return canClaimInitiatorStatus
  }

  claimInitiatorStatus() {
    if (this.canClaimInitiatorStatus(this.selfName)) {
      this.broadcastMessage({
        'type': this.MESSAGE_TYPE_NAMES['claimInitiator'],
        'data': {
          'initiatedBy': this.selfName
        },
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })
      return this.awaitQuorum(this.MESSAGE_TYPE_NAMES['claimInitiator'])
    } else {
      console.log("Cannot claim initiator status. Another peer is currently the initiator.")
      return undefined
    }
  }

  async initializeModel(modelConfig, shareWeights = true) {
    if (this.canClaimInitiatorStatus(this.selfName)) {
      this.isInitiator = await this.claimInitiatorStatus()

      if (modelConfig?.framework) {
        const { FedModel } = await import("./webFed_model.js")
        this.model = new FedModel(modelConfig)
      } else {
        this.model = modelConfig
      }

      this.broadcastMessage({
        'type': this.MESSAGE_TYPE_NAMES['initialModelInfo'],
        'data': modelConfig?.framework ? modelConfig : undefined,
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })

      console.log("Model initialized!")
    } else {
      console.error("Cannot initialize model either because someone else initiated the exercise or you don't have the authority.")
    }
  }

  setTrainingParams({ numEpochsToAggregateAfter = 5, aggregationStrategy = 1, minEpochs = 50 }) {

    this.trainingParams = {
      ...this.trainingParams,
      numEpochsToAggregateAfter,
      aggregationStrategy,
      minEpochs
    }
    this.broadcastMessage({
      'type': this.MESSAGE_TYPE_NAMES['trainingParams'],
      'data': {
        'numEpochsToAggregateAfter': numEpochsToAggregateAfter,
        'aggregationStrategy': aggregationStrategy,
        'minEpochs': minEpochs
      },
      'acknowledged': [this.selfName]
    })

    console.log("Training params set!")
  }

  async startTraining(args) {
    if (!this.model?.framework) {
      // Training will likely be handled by the caller.
      return
    }
    await this.awaitQuorum(this.MESSAGE_TYPE_NAMES['initialModelInfo'])
    await this.awaitQuorum(this.MESSAGE_TYPE_NAMES['trainingParams'])

    this.stopRequested = false
    console.log("STARTING TRAINING!", !!this.isInitiator)

    if (this.isInitiator) {
      this.broadcastMessage({
        'type': this.MESSAGE_TYPE_NAMES['startTraining'],
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })
    }
    this.currentEpoch = 0
    this.metrics = {
      'history': {
        'loss': [],
        'acc': []
      }
    }

    while (!this.stopRequested && this.currentEpoch < this.trainingParams.minEpochs) {
      const epochToAggregateAfter = this.currentEpoch + this.trainingParams.numEpochsToAggregateAfter
      await this.runTrainingIteration(epochToAggregateAfter, args)
      await this.roundCompleteCallback(await this.model.getWeights())
      
      const aggregatedParameters = await this.aggregateWeights()
      // console.log(aggregatedParameters)
  
      this.model.setWeights(aggregatedParameters)
    }
  }

  async runTrainingIteration(epochToAggregateAfter, args) {
    const { trainingData, trainingLabels } = args?.trainingParams?.dataset || this.trainingParams.dataset
    for (let epoch = this.currentEpoch; epoch < epochToAggregateAfter; epoch++) {
      this.currentEpoch = epoch

      const gradientUpdate = await this.model.fit(trainingData, trainingLabels, epoch, 1, args)
      this.metrics.history.loss.push(gradientUpdate.history.loss)
      this.metrics.history.acc.push(gradientUpdate.history.acc)
      console.log(gradientUpdate.history.loss, gradientUpdate.history.acc)
      console.log(`Epoch ${epoch} completed!`)
    }
  }

  roundCompleteCallback(weights) {
    for (const shardIndex in weights) {
      this.broadcastParams({
        'type': this.MESSAGE_TYPE_NAMES[`roundComplete`],
        'data': {
          'epoch': this.currentEpoch,
          'shardIndex': shardIndex,
          'weights': weights[shardIndex]
        },
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })
    }
  }

  async aggregateWeights(aggregationStrategy = 1) {
    const currentEpochMessages = this.getParams({
      'messageType': this.MESSAGE_TYPE_NAMES['roundComplete'],
      'dataFilters': {
        'initialEpoch': this.currentEpoch
      }
    })
    console.log(currentEpochMessages, this.parametersSharedArray.toArray())

    while (currentEpochMessages.length < this.getNumPeers() * this.quorumThreshold * (this.model.getWeights()).length) {
      await new Promise(res => setTimeout(res, 1000))
      return this.aggregateWeights(aggregationStrategy)
    }

    let aggregatedParameters = undefined
    switch (aggregationStrategy) {
      case 1:
        const { federatedAveraging } = await import("./aggregationMethods.js")
        const allWeights = []
        for (const peer of this.getAllPeers()) {
          const modelWiseWeights = currentEpochMessages.filter(message => message.from === peer.name).sort((a,b) => {a.data.shardIndex - b.data.shardIndex}).map(model => model.data.weights)
          allWeights.push(modelWiseWeights)
        }
        console.log(allWeights)
        aggregatedParameters = federatedAveraging(allWeights)
        break
      default:
        break
    }

    return aggregatedParameters
  }

  stopTraining() {
    this.stopRequested = true
    this.broadcastMessage({
      'type': this.MESSAGE_TYPE_NAMES['stopTraining'],
      'data': {},
      'from': this.selfName,
      'acknowledged': [this.selfName]
    })
  }

  _isWebRTCPeerConnected(webRTCPeerId) {
    return this.provider.room?.webrtcConns.get(webRTCPeerId)?.connected
  }

  _isWebRTCPeerSynced(webRTCPeerId) {
    return this.provider.room?.webrtcConns.get(webRTCPeerId)?.synced
  }

  _getAllWebRTCPeerIds() {
    const WebRTCpeerIds = []
    this.provider.room?.webrtcConns.keys().forEach(WebRTCpeerId => WebRTCpeerIds.push(WebRTCpeerId))
    return WebRTCpeerIds
  }

  _getNumberOfWebRTCPeers() {
    return (this.getAllWebRTCPeerIds()).length
  }

  _getConnectedWebRTCPeers() {
    const connectedWebRTCPeerIds = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (value.connected) {
        connectedWebRTCPeerIds.push(key)
      }
    })
    return connectedWebRTCPeerIds
  }

  _getDisconnectedWebRTCPeers() {
    const disconnectedWebRTCPeerIds = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (!value.connected) {
        disconnectedWebRTCPeerIds.push(key)
      }
    })
    return disconnectedWebRTCPeerIds
  }

  _getSyncedWebRTCPeers() {
    const synced = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (value.synced) {
        synced.push(key)
      }
    })
    return synced
  }

  _sendMessageToWebRTCPeer(webRTCPeerId, message) {
    this.provider.room?.webrtcConns.get(webRTCPeerId)?.peer.send(message)
  }

  _expectMessageFromWebRTCPeer(webRTCPeerId, callback) {
    this.provider.room?.webrtcConns.get(webRTCPeerId)?.peer.on('data', callback)
  }

}