export interface CreatedThread {
	id: string;
	name: string;
}

/** Creates a standalone public thread in a text channel (not attached to a starter message). */
export async function createThread(
	token: string,
	parentChannelId: string,
	name: string,
	autoArchiveDuration = 1440,
): Promise<CreatedThread> {
	const response = await fetch(`https://discord.com/api/v10/channels/${parentChannelId}/threads`, {
		method: "POST",
		headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: autoArchiveDuration, type: 11 }),
	});
	const data = (await response.json()) as { id?: string; name?: string; message?: string };
	if (!response.ok || !data.id) throw new Error(data.message || "Could not create Discord thread");
	return { id: data.id, name: data.name ?? name };
}
