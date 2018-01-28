'use strict'
var CryptoJS = require('crypto-js')
var express = require('express')
var bodyParser = require('body-parser')
var WebSocket = require('ws')

var httpPort = process.env.HTTP_PORT || 3001
var p2pPort = process.env.P2P_PORT || 6001
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : []

class Block {
  constructor (index, previousHash, timestamp, data, hash, nonce) {
    this.index = index
    this.previousHash = previousHash.toString()
    this.timestamp = timestamp
    this.data = data
    this.hash = hash.toString()
    this.nonce = nonce
  }
}

var sockets = []
var MessageType = {
  QUERY_LATEST: 0,
  QUERY_ALL: 1,
  RESPONSE_BLOCKCHAIN: 2
}

var getGenesisBlock = () => {
  return new Block(0, '0', 1465154705, '-> toni 100 coins', '4df43c5af7351f1476714e25be617b1ceab30f4bc48ec34c1b30e525478165a9', 10000)
}

var blockchain = [getGenesisBlock()]

var initHttpServer = () => {
  var app = express()
  app.use(bodyParser.json())

  app.get('/blocks', (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify(blockchain))
  })
  app.get('/manipulate', (req, res) => {
    blockchain[req.query.index].data = 'everything to peter'
    var newHashAndNonce = calculateHashAndNonceForBlock(blockchain[req.query.index])
    blockchain[req.query.index].hash = newHashAndNonce.hash
    blockchain[req.query.index].nonce = newHashAndNonce.nonce
    res.send()
  })
  app.get('/validate', (req, res) => {
    var status = false
    var foundInitial = false
    if (req.query.index) {
      for (var i = blockchain.length - 1; i >= 0; i--) {
        if (blockchain[i].index === req.query.index || foundInitial) {
          status = calculateHashForBlock(blockchain[i]) === blockchain[i].hash && (i === 0 || blockchain[i].previousHash === blockchain[i - 1].hash)
          if (status) {
            foundInitial = true
          } else if (foundInitial) {
            status = 'error on block with index ' + blockchain[i].index
            break
          }
        }
      }
    }
    res.send(JSON.stringify({status: status}))
  })
  app.post('/mineBlock', (req, res) => {
    var newBlock = generateNextBlock(req.body.data)
    addBlock(newBlock)
    broadcast(responseLatestMsg())
    console.log('\x1b[34m%s\x1b[0m', 'block added: ' + JSON.stringify(newBlock, null, 4))
    res.send()
  })
  app.get('/peers', (req, res) => {
    res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort))
  })
  app.get('/generateStatus', (req, res) => {
    setInterval(function () {
      var newBlock = generateNextBlock('{"data":"Health Status 100%"')
      addBlock(newBlock)
      broadcast(responseLatestMsg())
    }, 10000)
  })
  app.post('/addPeer', (req, res) => {
    connectToPeers([req.body.peer])
    res.send()
  })
  app.listen(httpPort, () => console.log('\x1b[34m%s\x1b[0m', 'Listening http on port: ' + httpPort))
}

var initP2PServer = () => {
  var server = new WebSocket.Server({port: p2pPort})
  server.on('connection', ws => initConnection(ws))
  console.log('\x1b[34m%s\x1b[0m', 'listening websocket p2p port on: ' + p2pPort)
}

var initConnection = (ws) => {
  sockets.push(ws)
  initMessageHandler(ws)
  initErrorHandler(ws)
  write(ws, queryChainLengthMsg())
}

var initMessageHandler = (ws) => {
  ws.on('message', (data) => {
    var message = JSON.parse(data)
    console.log('\x1b[32m%s\x1b[0m', 'Received message ' + JSON.stringify(message, null, 4))
    switch (message.type) {
      case MessageType.QUERY_LATEST:
        write(ws, responseLatestMsg())
        break
      case MessageType.QUERY_ALL:
        write(ws, responseChainMsg())
        break
      case MessageType.RESPONSE_BLOCKCHAIN:
        handleBlockchainResponse(message)
        break
    }
  })
}

var initErrorHandler = (ws) => {
  var closeConnection = (ws) => {
    console.log('\x1b[34m%s\x1b[0m', 'connection failed to peer: ' + ws.url)
    sockets.splice(sockets.indexOf(ws), 1)
  }
  ws.on('close', () => closeConnection(ws))
  ws.on('error', () => closeConnection(ws))
}

var generateNextBlock = (blockData) => {
  var previousBlock = getLatestBlock()
  var nextIndex = previousBlock.index + 1
  var nextTimestamp = new Date().getTime() / 1000
  var calculatedHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData)
  var nextHash = calculatedHash.hash
  var nextNonce = calculatedHash.nonce
  return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, nextNonce)
}

var calculateHashForBlock = (block) => {
  return calculateHashAndNonceForBlock(block).hash
}
var calculateHashAndNonceForBlock = (block) => {
  return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.nonce)
}

var calculateHash = (index, previousHash, timestamp, data, nonce) => {
  if (nonce) {
    return {hash: CryptoJS.SHA256(index + previousHash + timestamp + data + nonce).toString(), nonce: nonce}
  }
  while (true) {
    nonce = Math.floor(Math.random() * 899999) + 100000
    var hash = CryptoJS.SHA256(index + previousHash + timestamp + data + nonce).toString()
    if (hash.toString().startsWith('000')) {
      return {hash: hash, nonce: nonce}
    }
  }
}

var addBlock = (newBlock) => {
  if (isValidNewBlock(newBlock, getLatestBlock())) {
    blockchain.push(newBlock)
  }
}

var isValidNewBlock = (newBlock, previousBlock) => {
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log('\x1b[34m%s\x1b[0m', 'invalid index')
    return false
  } else if (previousBlock.hash !== newBlock.previousHash) {
    console.log('\x1b[34m%s\x1b[0m', 'invalid previoushash')
    return false
  } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
    console.log('\x1b[34m%s\x1b[0m', typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock))
    console.log('\x1b[34m%s\x1b[0m', 'invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash)
    return false
  }
  return true
}

var connectToPeers = (newPeers) => {
  newPeers.forEach((peer) => {
    var ws = new WebSocket(peer)
    ws.on('open', () => initConnection(ws))
    ws.on('error', () => {
      console.log('\x1b[34m%s\x1b[0m', 'connection failed')
    })
  })
}

var handleBlockchainResponse = (message) => {
  var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index))
  var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1]
  var latestBlockHeld = getLatestBlock()
  if (latestBlockReceived.index > latestBlockHeld.index) {
    console.log('\x1b[34m%s\x1b[0m', 'blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index)
    if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
      console.log('\x1b[34m%s\x1b[0m', 'We can append the received block to our chain')
      blockchain.push(latestBlockReceived)
      broadcast(responseLatestMsg())
    } else if (receivedBlocks.length === 1) {
      console.log('\x1b[34m%s\x1b[0m', 'We have to query the chain from our peer')
      broadcast(queryAllMsg())
    } else {
      console.log('\x1b[34m%s\x1b[0m', 'Received blockchain is longer than current blockchain')
      replaceChain(receivedBlocks)
    }
  } else {
    console.log('\x1b[34m%s\x1b[0m', 'Received blockchain is not longer than received blockchain. Do nothing')
  }
}

var replaceChain = (newBlocks) => {
  if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
    console.log('\x1b[34m%s\x1b[0m', 'Received blockchain is valid. Replacing current blockchain with received blockchain')
    blockchain = newBlocks
    broadcast(responseLatestMsg())
  } else {
    console.log('\x1b[34m%s\x1b[0m', 'Received blockchain invalid')
  }
}

var isValidChain = (blockchainToValidate) => {
  if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
    return false
  }
  var tempBlocks = [blockchainToValidate[0]]
  for (var i = 1; i < blockchainToValidate.length; i++) {
    if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
      tempBlocks.push(blockchainToValidate[i])
    } else {
      return false
    }
  }
  return true
}

var getLatestBlock = () => blockchain[blockchain.length - 1]
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST})
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL})
var responseChainMsg = () => ({
  'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
})
var responseLatestMsg = () => ({
  'type': MessageType.RESPONSE_BLOCKCHAIN,
  'data': JSON.stringify([getLatestBlock()])
})

var write = (ws, message) => ws.send(JSON.stringify(message))
var broadcast = (message) => sockets.forEach(socket => write(socket, message))

connectToPeers(initialPeers)
initHttpServer()
initP2PServer()
