import broker from 'message-broker'
import services from './services/index.js'
import { logger } from './utils/logging.js'
import { metrics } from './utils/metrics.js'
import { performance } from 'perf_hooks'

const topicPrefix = `${process.env.NODE_ENV}/`
const broadcastTopic = 'broadcast'

const subscribe = () => {
  const topic = 'externalRequest'
  broker.client.subscribe(`${topicPrefix}${topic}`, (err) => {
    logger.info(`subscribed to ${topicPrefix}${topic}`)
    if (err) {
      logger.error({
        error: err.toString(),
        topic
      })
    }
  })
}

const reshapeMeta = (requestPayload) => {
  const sentMeta = requestPayload?.meta
  delete requestPayload?.meta
  return { ...requestPayload, ...sentMeta }
}

if (broker.client.connected) {
  subscribe()
} else {
  broker.client.on('connect', subscribe)
}

broker.client.on('error', (err) => {
  logger.error({
    error: err.toString()
  })
})

broker.client.on('message', async (topic, data) => {
  const startTime = performance.now()
  const topicName = topic.substring(topicPrefix.length)
  metrics.count('receivedMessage', { topicName })
  let requestPayload
  let reshapedMeta
  try {
    requestPayload = JSON.parse(data.toString())
    reshapedMeta = reshapeMeta(requestPayload)
    const validatedRequest = broker[topicName].validate(requestPayload)
    if (validatedRequest.errors) throw { message: validatedRequest.errors } // eslint-disable-line
    const processedResponse = await services[validatedRequest.service](validatedRequest.query, reshapedMeta)
    if (!processedResponse) return
    processedResponse.messageId = reshapedMeta.messageId
    const validatedResponse = broker[broadcastTopic].validate({
      response: processedResponse,
      meta: reshapedMeta
    })
    if (validatedResponse.errors) throw { message: validatedResponse.errors } // eslint-disable-line

    broker.client.publish(`${topicPrefix}${broadcastTopic}`, JSON.stringify(validatedResponse))

    metrics.timer('responseTime', performance.now() - startTime, { topic })
  } catch (error) {
    console.log(error.message)
    requestPayload.error = error.message
    const validatedResponse = broker.responseRead.validate({
      key: 'somethingWentWrong',
      category: 'system',
      meta: reshapedMeta
    })
    metrics.count('error', { topicName })
    broker.client.publish(`${topicPrefix}responseRead`, JSON.stringify(validatedResponse))
  }
})
