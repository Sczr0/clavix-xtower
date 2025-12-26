export type SseEvent = {
	event: string | null;
	data: string;
	id: string | null;
};

type StreamSseOptions = {
	signal?: AbortSignal;
};

function parseSseChunk(raw: string): SseEvent[] {
	const blocks = raw.replaceAll('\r', '').split('\n\n');
	const events: SseEvent[] = [];

	for (const block of blocks) {
		const lines = block.split('\n');
		let event: string | null = null;
		let id: string | null = null;
		const dataLines: string[] = [];

		for (const line of lines) {
			if (!line) continue;
			if (line.startsWith(':')) continue;

			const idx = line.indexOf(':');
			const field = (idx === -1 ? line : line.slice(0, idx)).trim();
			const value = idx === -1 ? '' : line.slice(idx + 1).trimStart();

			if (field === 'event') event = value || null;
			else if (field === 'id') id = value || null;
			else if (field === 'data') dataLines.push(value);
		}

		if (dataLines.length === 0) continue;
		events.push({ event, id, data: dataLines.join('\n') });
	}

	return events;
}

export async function streamSse(
	response: Response,
	onEvent: (event: SseEvent) => void | boolean,
	options: StreamSseOptions = {}
): Promise<void> {
	if (!response.body) throw new Error('响应缺少 body，无法读取流式数据');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	let buffer = '';

	try {
		while (true) {
			if (options.signal?.aborted) {
				await reader.cancel();
				return;
			}

			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replaceAll('\r', '');

			const delimiterIndex = buffer.lastIndexOf('\n\n');
			if (delimiterIndex === -1) continue;

			const ready = buffer.slice(0, delimiterIndex);
			buffer = buffer.slice(delimiterIndex + 2);

			for (const event of parseSseChunk(ready)) {
				const keepGoing = onEvent(event);
				if (keepGoing === false) {
					await reader.cancel();
					return;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
