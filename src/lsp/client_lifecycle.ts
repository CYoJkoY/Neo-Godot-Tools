export async function stopAfterStart(
	starting: Promise<void> | undefined,
	isRunning: () => boolean,
	stop: () => Promise<void>,
): Promise<void> {
	if (starting) {
		try {
			await starting;
		} catch {
			// A failed start leaves no running client for the caller to stop.
			return;
		}
	}
	if (isRunning()) await stop();
}
