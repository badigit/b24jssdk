import { LoggerBrowser, LoggerType } from '../../logger/browser'
import { MessageCommands } from './commands'
import { AppFrame } from '../frame'
import Text from '../../tools/text'
import { omit } from '../../tools'

interface PromiseHandlers {
  resolve: (value: any) => void
  reject: (reason?: any) => void
  timeoutId: any
}

/**
 * Parent Window Request Parameters
 * @prop isRawValue if true then JSON.stringify will not be executed
 * @prop isSafely auto completion mode Promise.resolve()
 * @prop safelyTime after what time (900 ms) should it be automatically resolved Promise
 * @prop callBack for placement event
 */
export interface SendParams {
  [index: string]: any

  isRawValue?: boolean
  isSafely?: boolean
  safelyTime?: number
  callBack?: (...args: any[]) => void
}

/**
 * Parent Window Communication Manager at B24
 */
export class MessageManager {
  #appFrame: AppFrame
  #callbackPromises: Map<string, PromiseHandlers>
  #callbackSingletone: Map<string, (...args: any[]) => void>
  protected _logger: null | LoggerBrowser = null
  private readonly runCallbackHandler: OmitThisParameter<(event: MessageEvent) => void>

  constructor(appFrame: AppFrame) {
    this.#appFrame = appFrame

    this.#callbackPromises = new Map()
    this.#callbackSingletone = new Map()

    this.runCallbackHandler = this._runCallback.bind(this)
  }

  setLogger(logger: LoggerBrowser): void {
    this._logger = logger
  }

  getLogger(): LoggerBrowser {
    if (null === this._logger) {
      this._logger = LoggerBrowser.build(`NullLogger`)

      this._logger.setConfig({
        [LoggerType.desktop]: false,
        [LoggerType.log]: false,
        [LoggerType.info]: false,
        [LoggerType.warn]: false,
        [LoggerType.error]: true,
        [LoggerType.trace]: false,
      })
    }

    return this._logger
  }

  // region Events ////
  /**
   * Subscribe to the onMessage event of the parent window
   */
  subscribe() {
    window.addEventListener('message', this.runCallbackHandler)
  }

  /**
   * Unsubscribe from the onMessage event of the parent window
   */
  unsubscribe(): void {
    window.removeEventListener('message', this.runCallbackHandler)
  }

  // endregion ////

  /**
   * Send message to parent window
   * The answer (if) we will get in _runCallback
   *
   * @param command
   * @param params
   */
  async send(
    command: string | MessageCommands,
    params: null | SendParams = null
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let cmd: string | object
      const promiseHandler: PromiseHandlers = {
        resolve,
        reject,
        timeoutId: null
      }

      const keyPromise = this.#setCallbackPromise(promiseHandler)
      let paramsSend: null | string | Record<string, any> = null

      const optionsSend = omit(params || {}, ['singleOption', 'callBack', 'isSafely', 'safelyTime'])
      const { callBack, singleOption } = params || {}
      if (callBack) {
        this.#callbackSingletone.set(keyPromise, callBack)
      }

      if (singleOption) {
        paramsSend = singleOption
      } else if (Object.keys(optionsSend).length > 0) {
        paramsSend = { ...optionsSend }
      }

      if (command.toString().includes(':')) {
        cmd = {
          method: command.toString(),
          params: paramsSend || '',
          callback: keyPromise,
          appSid: this.#appFrame.getAppSid(),
        }
      } else {
        /**
         * @memo: delete it after rest 22.0.0
         */
        cmd = command.toString()

        if (params?.isRawValue !== true) {
          if(!!paramsSend) {
            paramsSend = JSON.stringify(paramsSend)
          }
        }

        const listParams = [
          paramsSend || '',
          keyPromise,
          this.#appFrame.getAppSid(),
        ]

        cmd += ':' + listParams.filter(Boolean).join(':')
      }

      this.getLogger().log(`send to ${ this.#appFrame.getTargetOrigin() }`, {
        cmd,
      })

      parent.postMessage(cmd, this.#appFrame.getTargetOrigin())

      if (params?.isSafely) {
        // @ts-ignore
        this.#callbackPromises.get(keyPromise).timeoutId = window.setTimeout(
          () => {
            if (this.#callbackPromises.has(keyPromise)) {
              this.getLogger().warn(
                `Action ${ command.toString() } stop by timeout`
              )

              this.#callbackPromises.delete(keyPromise)
              resolve({ isSafely: true })
            }
          },
          Number.parseInt(String(params?.safelyTime || 900))
        )
      }
    })
  }

  /**
   * Fulfilling a promise based on messages from the parent window
   *
   * @param event
   * @private
   */
  public _runCallback(event: MessageEvent): void {
    if (event.origin !== this.#appFrame.getTargetOrigin()) {
      return
    }

    if (event.data) {
      this.getLogger().log(`get from ${ event.origin }`, {
        data: event.data,
      })

      const tmp = event.data.split(':')

      const cmd: { id: string; args: any } = {
        id: tmp[0],
        args: tmp.slice(1).join(':'),
      }

      if (cmd.args) {
        cmd.args = JSON.parse(cmd.args)
      }

      if (this.#callbackPromises.has(cmd.id)) {
        const promise = this.#callbackPromises.get(cmd.id) as PromiseHandlers
        if (promise.timeoutId) {
          clearTimeout(promise.timeoutId)
        }

        this.#callbackPromises.delete(cmd.id)

        promise.resolve(cmd.args)
        // promise.reject(cmd.args) ////
      } else if (this.#callbackSingletone.has(cmd.id)) {
        const callBack = this.#callbackSingletone.get(cmd.id) as (...args: any[]) => void
        if (callBack) {
          callBack.apply(globalThis, [cmd.args])
        }
      }
    }
  }

  /**
   * Storing a promise for a message from the parent window
   *
   * @param promiseHandler
   * @private
   *
   * @memo We don't use Symbol here, because we need to pass it to the parent and then find and restore it.
   */
  #setCallbackPromise(promiseHandler: PromiseHandlers): string {
    const key = Text.getUniqId()
    this.#callbackPromises.set(key, promiseHandler)
    return key
  }
}
