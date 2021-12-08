import exitHook = require('exit-hook')

import { DataTransferLockingQueue, DataTransferSimpleQueue, DataTransferQueueBase } from './dataTransferQueue'
import DataTransferUploadStill from './dataTransferUploadStill'
import { DataTransferUploadClipFrame, DataTransferUploadClip } from './dataTransferUploadClip'
import DataTransferUploadAudio from './dataTransferUploadAudio'
import { IDeserializedCommand, ISerializableCommand } from '../commands/CommandBase'
import DataTransferUploadMultiViewerLabel from './dataTransferUploadMultiViewerLabel'
import { DataDownloadMacro, DataUploadMacro } from './dataTransferMacro'
import { LockObtainedCommand, LockStateUpdateCommand } from '../commands/DataTransfer'

const MAX_PACKETS_TO_SEND_PER_TICK = 10
const MAX_TRANSFER_INDEX = (1 << 16) - 1 // Inclusive maximum

export class DataTransferManager {
	#nextTransferIdInner = 0
	readonly #nextTransferId = (): number => {
		const index = this.#nextTransferIdInner++
		if (this.#nextTransferIdInner > MAX_TRANSFER_INDEX) this.#nextTransferIdInner = 0
		return index
	}

	readonly #sendLockCommand = (/*lock: DataTransferLockingQueue,*/ cmd: ISerializableCommand): void => {
		Promise.all(this.#rawSendCommands([cmd])).catch(() => {
			console.log('Failed to send lock command')
		})
	}

	readonly #stillsLock = new DataTransferLockingQueue(0, this.#sendLockCommand, this.#nextTransferId)
	readonly #clipLocks = new Map<number, DataTransferLockingQueue>() // clipLocks get dynamically allocated
	readonly #labelsLock = new DataTransferSimpleQueue(this.#nextTransferId)
	readonly #macroLock = new DataTransferSimpleQueue(this.#nextTransferId)

	readonly #rawSendCommands: (cmds: ISerializableCommand[]) => Array<Promise<void>>

	private interval?: NodeJS.Timer
	private exitUnsubscribe?: () => void

	constructor(rawSendCommands: (cmds: ISerializableCommand[]) => Array<Promise<void>>) {
		this.#rawSendCommands = rawSendCommands
	}

	private get allLocks() {
		return [this.#stillsLock, ...this.#clipLocks.values(), this.#labelsLock]
	}

	/**
	 * Start sending of commands
	 * This is called once the connection has received the initial state data
	 */
	public startCommandSending(): void {
		// TODO - abort any active transfers

		if (!this.interval) {
			// New connection means a new queue
			for (const lock of this.allLocks) {
				lock.clearQueueAndAbort(new Error('Restarting connection'))
			}

			this.interval = setInterval(() => {
				for (const lock of this.allLocks) {
					const commandsToSend = lock.popQueuedCommands(MAX_PACKETS_TO_SEND_PER_TICK) // Take some, it is unlikely that multiple will run at once
					if (commandsToSend) {
						Promise.all(this.#rawSendCommands(commandsToSend)).catch(() => {
							// Failed to send/queue something, so abort it
							lock.tryAbortTransfer(new Error('Command send failed'))
						})
					}
				}
			}, 2) // TODO - refine this. perhaps we can stop and restart the interval?
		}
		if (!this.exitUnsubscribe) {
			this.exitUnsubscribe = exitHook(() => {
				this.stopCommandSending()
			})
		}
	}

	/**
	 * Stop sending of commands
	 * This is called once the connection is disconnected
	 */
	public stopCommandSending(): void {
		for (const lock of this.allLocks) {
			lock.clearQueueAndAbort(new Error('Stopping connection'))
		}

		if (this.exitUnsubscribe) {
			this.exitUnsubscribe()
			this.exitUnsubscribe = undefined
		}
		if (this.interval) {
			clearInterval(this.interval)
			this.interval = undefined
		}
	}

	/**
	 * Queue the handling of a received command
	 * We do it via a queue as some of the handlers need to be async, and we don't want to block state updates from happening in parallel
	 */
	public queueHandleCommand(command: IDeserializedCommand): void {
		if (command instanceof LockObtainedCommand || command instanceof LockStateUpdateCommand) {
			let lock: DataTransferLockingQueue | undefined
			if (command.properties.index === 0) {
				lock = this.#stillsLock
			} else if (command.properties.index >= 100) {
				// Looks like a special lock that we arent expecting
				// Ignore it for now
				return
			} else {
				lock = this.#clipLocks.get(command.properties.index)
			}

			// Must be a clip that we aren't expecting
			if (!lock)
				lock = new DataTransferLockingQueue(
					command.properties.index,
					this.#sendLockCommand,
					this.#nextTransferId
				)

			// handle actual command
			if (command instanceof LockObtainedCommand) {
				lock.lockObtained()
			} else if (command instanceof LockStateUpdateCommand) {
				lock.updateLock(command.properties.locked)
			}

			return
		}

		// If this command is for a transfer
		if (command.properties.transferId !== undefined) {
			// try to establish the associated DataLock:
			let lock: DataTransferQueueBase | undefined
			for (const _lock of this.allLocks) {
				if (_lock.currentTransferId === command.properties.transferId) {
					lock = _lock
				}
			}

			// console.log('CMD', command.constructor.name)
			// Doesn't appear to be for a known lock
			// TODO - should we fire an abort back just in case?
			if (!lock) return

			lock.handleCommand(command)
			// } else {
			// 	// debugging:
			// 	console.log('UNKNOWN COMMAND:', command)
		}
	}

	public uploadStill(index: number, data: Buffer, name: string, description: string): Promise<void> {
		const transfer = new DataTransferUploadStill(index, data, name, description)
		return this.#stillsLock.enqueue(transfer)
	}

	public uploadClip(index: number, data: Iterable<Buffer> | AsyncIterable<Buffer>, name: string): Promise<void> {
		const provideFrame = async function* (): AsyncGenerator<DataTransferUploadClipFrame, undefined> {
			let id = -1
			for await (const frame of data) {
				id++
				yield new DataTransferUploadClipFrame(index, id, frame)
			}
			return undefined
		}
		const transfer = new DataTransferUploadClip(index, name, provideFrame(), this.#nextTransferId)
		const lock = this.getClipLock(index)
		return lock.enqueue(transfer)
	}

	public uploadAudio(index: number, data: Buffer, name: string): Promise<void> {
		const transfer = new DataTransferUploadAudio(index, data, name)
		const lock = this.getClipLock(index)
		return lock.enqueue(transfer)
	}

	public downloadMacro(index: number): Promise<Buffer> {
		const transfer = new DataDownloadMacro(index)

		return this.#macroLock.enqueue(transfer)
	}

	public uploadMacro(index: number, data: Buffer, name: string): Promise<void> {
		const transfer = new DataUploadMacro(index, data, name)

		return this.#macroLock.enqueue(transfer)
	}

	public uploadMultiViewerLabel(index: number, data: Buffer): Promise<void> {
		const transfer = new DataTransferUploadMultiViewerLabel(index, data)
		return this.#labelsLock.enqueue(transfer)
	}

	private getClipLock(index: number): DataTransferLockingQueue {
		const lock = this.#clipLocks.get(index)
		if (lock) {
			return lock
		} else {
			throw new Error('Invalid clip index')
		}
	}
}
