// import peerjs from "https://cdn.skypack.dev/peerjs"

const p2p = (() => {
  const setupDeps = () => {
    const peerJSScript = document.createElement("script")
    peerJSScript.src = "https://unpkg.com/peerjs@1.5.1/dist/peerjs.min.js"
    const peerJSGroupsScript = document.createElement("script")
    peerJSGroupsScript.src = "https://cdn.jsdelivr.net/gh/ElizabethHudnott/peerjs-groups@master/dist/peerjs-groups.js"

    document.body.appendChild(peerJSScript)
    document.body.appendChild(peerJSGroupsScript)
  }
  setupDeps()
  return {}
})()

p2p.initializeFederation = (initOptions) => new Promise(resolve => {
  const { 
    clientId=crypto.randomUUID(),
    federationId,
    signalingServerHost="0.peerjs.com",
    signalingServerPort=443,
    newUserCallback,
    newMessageCallback
  } = initOptions
  p2p.group = new PeerGroup((err)=> {
    console.error("Error initializing federation:", err)
  }, {
    host: signalingServerHost,
    port: signalingServerPort,
    debug: 2
  })

  p2p.group.addEventListener('connected', (e) => {
    console.log(`Connected to session ${e.sessionID}`);
    p2p.clientId = clientId
    p2p.federationId = e.sessionID
  })

  p2p.group.addEventListener('joined', (e) => {
    console.log(`Joined session ${e.sessionID}`);
    p2p.clientId = clientId
    p2p.federationId = e.sessionID
    resolve({ clientId: p2p.clientId, federationId: p2p.federationId })
  })

  p2p.group.addEventListener('userpresent', (e) => {
    console.log(`New User`, e.userID)
    newUserCallback(e)
  })

  p2p.group.addEventListener('message', (e) => {
    // console.log(`Message received:`, e.message)
    newMessageCallback(e)
  })

  // p2p.group.addEventListener('joined', (e) => console.log(`Joined session ${e.sessionId}`))
  console.log(`Attempting connection to federation ${federationId} from ${clientId}`)
  p2p.group.connect(federationId, clientId)

})

p2p.sendDataToPeer = (peerId, data) => {
  p2p.group.sendPrivate(peerId, data)
}

p2p.broadcastData = (data) => {
  p2p.group.send(data)
}

export default p2p