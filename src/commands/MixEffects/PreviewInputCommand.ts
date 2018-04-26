import AbstractCommand from '../AbstractCommand'
import { AtemState } from '../../state'

export class PreviewInputCommand extends AbstractCommand {
	rawName = 'PrvI'
	mixEffect: number

	protected properties: {
		source: number
	}

	deserialize (rawCommand: Buffer) {
		this.mixEffect = rawCommand[0]
		this.properties = {
			source: rawCommand.readUInt8(2)
		}
	}

	serialize () {
		let rawCommand = 'CPvI'
		return new Buffer([
			...Buffer.from(rawCommand),
			this.mixEffect,
			0x00,
			this.properties.source >> 8,
			this.properties.source & 0xFF
		])
	}

	applyToState (state: AtemState) {
		let mixEffect = state.video.getMe(this.mixEffect)
		mixEffect.programInput = this.properties.source
	}
}
