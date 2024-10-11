// import gunDB from './gunWrapper.js'
// import p2p from './yjsWrapper.js'

import { Doc, WebrtcProvider } from "https://cdn.jsdelivr.net/gh/rozek/yjs-bundle/dist/yjs-bundle.esm.js"

const DEFAULT_FEDERATION_NAME = "federation_x"
const PEERS_SHARED_ARRAY_NAME = "peers"
const MESSAGES_SHARED_ARRAY_NAME = "messages"
const PARAMETERS_SHARED_ARRAY_NAME = "parameters"

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
      this.selfName = selfName
      this.peersSharedArray.push([{
        name: this.selfName,
        joinedAt: Date.now(),
        _webRTCPeerId: this.getSelfWebRTCPeerId()
      }])

      this.peersSharedArray.observeDeep((event) => {
        // Handle delta calculation later
        console.log(event)
        const newPeerEvent = new CustomEvent("newPeer", {
          detail: event
        })
        document.dispatchEvent(newPeerEvent)
        // console.log(event.changes.delta)
      })
      this.messagesSharedArray.observeDeep((event) => {
        this.messagesSharedArray.forEach(async (messageObj, index) => {
          if (!messageObj?.acknowledged?.includes(this.selfName)) {
            switch (messageObj.type) {
              case 'claimInitiator':
                const claimInitiatorEvent = new CustomEvent("claimInitiator", messageObj)
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

              case 'initialModelInfo':
                const { FedModel } = await import("./webFed_model.js")
                this.model = new FedModel(messageObj.data)
                const initialModelInfoReceivedEvent = new CustomEvent("initialModelInfo", {
                  detail: messageObj
                })
                document.dispatchEvent(initialModelInfoReceivedEvent)
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break

              case 'trainingParams':
                const trainingParamsEvent = new CustomEvent("trainingParams", messageObj)
                document.dispatchEvent(trainingParamsEvent)
                const { data: trainingParams } = messageObj
                this.trainingParams = {
                  ...this.trainingParams,
                  ...trainingParams
                }
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break

              case 'startTraining':
                const startTrainingEvent = new CustomEvent("startTraining", messageObj)
                document.dispatchEvent(startTrainingEvent)
                this.startTraining()
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break

              case 'roundComplete':
                const trainingRoundCompleteEvent = new CustomEvent("trainingRoundComplete", messageObj)
                document.dispatchEvent(trainingRoundCompleteEvent)
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

    })

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

  checkQuorum(messageType) {
    let wasQuorumAchieved = false
    this.messagesSharedArray.forEach(message => {
      if (message.type === messageType && message.acknowledged.length == this.getNumPeers() * this.quorumThreshold) {
        wasQuorumAchieved = true
      }
    })
    return wasQuorumAchieved
  }

  awaitQuorum(messageType) {
    return new Promise((resolve, reject) => {
      const quorumChecker = setInterval(() => {
        if (this.checkQuorum(messageType)) {
          clearInterval(quorumChecker)
          resolve(true)
        }
      }, 200)
    })
  }

  canClaimInitiatorStatus(name) {
    let canClaimInitiatorStatus = true
    this.messagesSharedArray.forEach(message => {
      if (message.type === "claimInitiator" && message.data.initiatedBy !== name && this.isPeerConnected(message.data.initiatedBy)) {
        canClaimInitiatorStatus = false
      }
    })
    return canClaimInitiatorStatus
  }

  claimInitiatorStatus() {
    if (this.canClaimInitiatorStatus(this.selfName)) {
      this.broadcastMessage({
        'type': "claimInitiator",
        'data': {
          'initiatedBy': this.selfName
        },
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })
      return this.awaitQuorum("claimInitiator")
    } else {
      console.log("Cannot claim initiator status. Another peer is currently the initiator.")
      return undefined
    }
  }

  async initializeModel(modelConfig, shareWeights = true) {
    if (this.canClaimInitiatorStatus(this.selfName)) {
      this.isInitiator = await this.claimInitiatorStatus()

      const { FedModel } = await import("./webFed_model.js")
      this.model = new FedModel(modelConfig)

      this.broadcastMessage({
        'type': "initialModelInfo",
        'data': modelConfig,
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })

      console.log("Model initialized!")
      // this.broadcastMessage({
      //   'type': "modelInfoSent",
      //   'acknowledged': [this.selfName]
      // })
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
      'type': "trainingParams",
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
    await this.awaitQuorum("initialModelInfo")
    await this.awaitQuorum("trainingParams")

    console.log("STARTING TRAINING!", !!this.isInitiator)

    if (this.isInitiator) {
      this.broadcastMessage({
        'type': "startTraining",
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

    while (this.currentEpoch < this.trainingParams.minEpochs) {
      const epochToAggregateAfter = this.currentEpoch + this.trainingParams.numEpochsToAggregateAfter
      await this.runTrainingIteration(epochToAggregateAfter, args)
      this.broadcastMessage({
        'type': "roundComplete",
        'data': {
          'initialEpoch': this.currentEpoch,
          'weights': await this.model.getWeights()
        },
        'from': this.selfName,
        'acknowledged': [this.selfName]
      })
      
      const aggregatedParameters = await this.aggregateWeights()
      console.log(aggregatedParameters)
  
      this.model.setWeights(aggregatedParameters)
    }
  }

  async runTrainingIteration(epochToAggregateAfter, args) {
    const { trainingData, trainingLabels } = args?.trainingParams?.dataset || this.trainingParams.dataset
    for (let epoch = this.currentEpoch; epoch < epochToAggregateAfter; epoch++) {
      this.currentEpoch = epoch

      const gradientUpdate = await this.model.train(trainingData, trainingLabels, epoch, 1, args)
      this.metrics.history.loss.push(gradientUpdate.history.loss)
      this.metrics.history.acc.push(gradientUpdate.history.acc)

      console.log(`Epoch ${epoch} completed!`)
    }
  }

  async aggregateWeights(aggregationStrategy = 1) {
    const currentEpochMessages = this.getMessages({
      'messageType': "roundComplete",
      'dataFilters': {
        'initialEpoch': this.currentEpoch
      }
    })

    while (currentEpochMessages.length < this.getNumPeers()) {
      await new Promise(res => setTimeout(res, 1000))
      return this.aggregateWeights(aggregationStrategy)
    }

    let aggregatedParameters = undefined
    switch (aggregationStrategy) {
      case 1:
        const { federatedAveraging } = await import("./aggregationMethods.js")
        const allWeights = currentEpochMessages.reduce((weightsArr, currentModel) => {
          weightsArr.push(currentModel.data.weights)
          return weightsArr
        }, [])
        
        aggregatedParameters = federatedAveraging(allWeights)
        break
      default:
        break
    }

    return aggregatedParameters
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

export const demoTrainingData = async (distributionType = "iid", datasetIndex = 1) => {
  const { tensor2d } = await import("https://esm.sh/@tensorflow/tfjs@4.20.0")
  const irisData = await (await fetch(`https://episphere.github.io/lab/iris_${distributionType}_${datasetIndex}.json`)).json()

  const trainSplit = 0.8
  const trainSplitIndex = Math.floor(irisData.length) * trainSplit
  const irisTrainingData = irisData.sort(() => Math.random() - 0.5).slice(0, trainSplitIndex)
  const irisTestData = irisData.slice(trainSplitIndex)

  const trainingData = tensor2d(irisTrainingData.map(({ sepal_length, sepal_width, petal_length, petal_width }) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))

  const trainingLabels = tensor2d(irisTrainingData.map(({ species }) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))

  const testData = tensor2d(irisTestData.map(({ sepal_length, sepal_width, petal_length, petal_width }) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))

  const testLabels = tensor2d(irisTestData.map(({ species }) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))

  return {
    trainingData,
    trainingLabels,
    testData,
    testLabels
  }
}