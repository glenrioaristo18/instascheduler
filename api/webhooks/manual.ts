import { google } from 'googleapis';

// ============== INLINED SERVER SHEET SERVICE ==============
const getServerSheetsClient = async () => {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable");
    }
    const credentials = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
};

const fetchServerSettings = async (spreadsheetId: string, settingsTabName: string = 'Settings') => {
    const sheets = await getServerSheetsClient();
    const settingsResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${settingsTabName}!A2:B10` });
    const settingsRows = settingsResponse.data.values || [];
    const globalSettings: Record<string, string> = {};
    settingsRows.forEach(row => { if (row[0] && row[1]) globalSettings[row[0]] = row[1]; });

    let profiles: any[] = [];
    try {
        const profilesResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: `Profiles!A2:I20` });
        const profileRows = profilesResponse.data.values || [];
        profiles = profileRows.map((row, index) => ({
            id: row[0] || `profile_${index}`,
            name: row[1] || 'Unnamed Profile',
            accountId: row[2] || '',
            accessToken: row[3] || '',
            sheetTabName: row[4] || 'Schedules',
            logsTabName: row[5] || `Logs - ${row[1] || 'Default'}`,
            imageKitPublicKey: row[6] || '',
            imageKitUrlEndpoint: row[7] || '',
            imageKitPrivateKey: row[8] || ''
        }));
    } catch (e) {
        console.warn("Profiles tab not found, using legacy settings if available.");
        if (globalSettings['INSTAGRAM_ACCOUNT_ID']) {
            profiles = [{ id: 'legacy', name: 'Default Account', accountId: globalSettings['INSTAGRAM_ACCOUNT_ID'], accessToken: globalSettings['INSTAGRAM_ACCESS_TOKEN'], sheetTabName: globalSettings['SHEET_TAB_NAME'] || 'Schedules', logsTabName: 'Logs', imageKitPublicKey: '', imageKitUrlEndpoint: '' }];
        }
    }
    return { profiles, globalSettings };
};

const appendServerRow = async (spreadsheetId: string, tabName: string, values: any[]) => {
    const sheets = await getServerSheetsClient();
    try {
        await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1` });
    } catch (e) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
        });
    }
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
    });
};
// ============== END INLINED SHEET SERVICE ==============

// ============== INLINED INSTAGRAM SERVICE ==============
const BASE_URL = "https://graph.facebook.com/v24.0";

interface MediaItem { id: string; url: string; type: 'IMAGE' | 'VIDEO'; }

const publishCarouselPost = async (accountId: string, accessToken: string, caption: string, mediaItems: MediaItem[], onProgress: (status: string) => void): Promise<string> => {
    if (!accountId || !accessToken) throw new Error("Missing Account ID or Access Token");
    if (mediaItems.length === 0) throw new Error("No media items provided");
    if (mediaItems.length > 10) throw new Error("Instagram carousels support a maximum of 10 items");

    const handleResponse = async (res: Response, stage: string) => {
        const data = await res.json();
        if (data.error) throw new Error(`Instagram API Error [${stage}]: ${data.error.message}${data.error.error_user_msg ? ' - ' + data.error.error_user_msg : ''}`);
        return data;
    };

    const waitForContainer = async (containerId: string, maxRetries = 20): Promise<void> => {
        for (let i = 0; i < maxRetries; i++) {
            const res = await fetch(`${BASE_URL}/${containerId}?fields=status_code&access_token=${accessToken}`);
            const data = await res.json();
            if (data.error) throw new Error(`Status Check Error: ${data.error.message}`);
            const status = data.status_code;
            console.log(`[Instagram API] Container ${containerId} status: ${status} (Attempt ${i + 1})`);
            if (status === 'FINISHED') return;
            if (status === 'ERROR') throw new Error("Instagram failed to process this media.");
            if (status === 'EXPIRED') throw new Error("Media container expired.");
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        throw new Error("Timeout waiting for Instagram to process media.");
    };

    try {
        const isCarousel = mediaItems.length > 1;
        let finalCreationId = "";

        if (isCarousel) {
            onProgress("Uploading carousel items...");
            const itemIds: string[] = [];
            for (const [index, item] of mediaItems.entries()) {
                let itemUrl = item.url;
                if (item.type === 'IMAGE' && itemUrl.includes('imagekit.io')) itemUrl += itemUrl.includes('?') ? '&tr=f-jpg' : '?tr=f-jpg';
                const body: any = { is_carousel_item: true };
                if (item.type === 'IMAGE') body.image_url = itemUrl;
                else { body.media_type = 'VIDEO'; body.video_url = itemUrl; }
                console.log(`[Instagram API] Uploading Carousel Item ${index + 1} (${item.type}):`, itemUrl);
                const res = await fetch(`${BASE_URL}/${accountId}/media?access_token=${accessToken}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                const data = await handleResponse(res, `Upload Media ${index + 1}`);
                itemIds.push(data.id);
            }
            onProgress("Waiting for items to process...");
            for (const id of itemIds) await waitForContainer(id);
            onProgress("Creating carousel container...");
            const res = await fetch(`${BASE_URL}/${accountId}/media?access_token=${accessToken}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ media_type: "CAROUSEL", caption, children: itemIds.join(',') }) });
            const carouselData = await handleResponse(res, "Create Carousel Container");
            finalCreationId = carouselData.id;
        } else {
            const item = mediaItems[0];
            onProgress(`Uploading single ${item.type.toLowerCase()}...`);
            let itemUrl = item.url;
            if (item.type === 'IMAGE' && itemUrl.includes('imagekit.io')) itemUrl += itemUrl.includes('?') ? '&tr=f-jpg' : '?tr=f-jpg';
            const body: any = { caption };
            if (item.type === 'IMAGE') body.image_url = itemUrl;
            else { body.media_type = 'VIDEO'; body.video_url = itemUrl; }
            console.log(`[Instagram API] Uploading Single ${item.type}:`, itemUrl);
            const res = await fetch(`${BASE_URL}/${accountId}/media?access_token=${accessToken}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const data = await handleResponse(res, "Upload Single Media");
            finalCreationId = data.id;
        }

        onProgress("Finalizing post...");
        await waitForContainer(finalCreationId);
        onProgress("Publishing to feed...");
        const publishRes = await fetch(`${BASE_URL}/${accountId}/media_publish?access_token=${accessToken}&creation_id=${finalCreationId}`, { method: "POST" });
        const publishData = await handleResponse(publishRes, "Publish Container");
        return publishData.id;
    } catch (error: any) {
        console.error("Publishing Failed:", error);
        throw error;
    }
};
// ============== END INLINED INSTAGRAM SERVICE ==============

export default async function handler(req: any, res: any) {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    const authHeader = req.headers.authorization;

    // Verify Authorization (Header Only)
    if (webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
        return res.status(401).json({ error: "Unauthorized: Invalid WEBHOOK_SECRET in Authorization header" });
    }

    if (!spreadsheetId) {
        return res.status(500).json({ error: "Server Configuration Error: Missing SPREADSHEET_ID environment variable" });
    }

    // Parse request body
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    // Action can be 'schedule' (just add to sheet) or 'publish' (add to sheet and post now)
    const {
        profileId,
        action = 'schedule',
        date,
        time = '',
        theme = '',
        title = '',
        caption = '',
        script = '',
        cta = '',
        mediaUrls = []
    } = body;

    if (!profileId || !date || !mediaUrls || mediaUrls.length === 0) {
        return res.status(400).json({ error: "Missing required fields: profileId, date, and mediaUrls" });
    }

    try {
        console.log(`[Webhook] Processing incoming post for profile ${profileId}, action: ${action}`);
        const { profiles } = await fetchServerSettings(spreadsheetId);

        const profile = profiles.find(p => p.id === profileId);

        if (!profile) {
            return res.status(404).json({ error: `Profile not found: ${profileId}` });
        }

        const { accountId, accessToken, sheetTabName, name } = profile;

        if (action === 'publish' && (!accountId || !accessToken)) {
            return res.status(400).json({ error: `Skipping profile ${name}: Missing credentials` });
        }

        // Determine day of week
        const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        let dayName = '';
        try {
            const dateObj = new Date(date);
            if (!isNaN(dateObj.getTime())) {
                dayName = days[dateObj.getDay()];
            }
        } catch (e) { }

        // Format media URLs
        let parsedMediaUrls: string[] = [];
        if (Array.isArray(mediaUrls)) {
            parsedMediaUrls = mediaUrls;
        } else if (typeof mediaUrls === 'string') {
            parsedMediaUrls = mediaUrls.split(',').map((s: string) => s.trim());
        }
        const mediaUrlsString = parsedMediaUrls.join(', ');

        let finalStatus = 'pending';
        let creationId = null;

        if (action === 'publish') {
            console.log(`[Webhook][${name}] Manual Publish requested...`);
            const mediaItems: MediaItem[] = parsedMediaUrls.map((url: string, i: number) => ({
                id: `webhook_${profileId}_${Date.now()}_${i}`,
                url,
                type: (url.toLowerCase().match(/\.(mp4|mov|avi|wmv|m4v)$/) ? 'VIDEO' : 'IMAGE') as 'IMAGE' | 'VIDEO'
            }));

            try {
                creationId = await publishCarouselPost(accountId, accessToken, caption, mediaItems, (statusMsg) => console.log(`[Webhook][${name}] ${statusMsg}`));
                finalStatus = 'published';
            } catch (postError: any) {
                console.error(`[Webhook][${name}] Failed to publish post:`, postError);
                finalStatus = 'failed';
            }
        }

        // Append to sheet EXACTLY like the frontend scheduler does
        // [Hari, Tanggal, Jam, Tema Konten, Judul / Hook, Caption, Script Singkat, CTA, Status, Link Posting]
        const rowValues = [
            dayName,
            date,
            time,
            theme,
            title,
            caption,
            script,
            cta,
            finalStatus,
            mediaUrlsString
        ];

        console.log(`[Webhook][${name}] Appending row to ${sheetTabName}:`, rowValues);
        await appendServerRow(spreadsheetId, sheetTabName, rowValues);

        if (action === 'publish' && finalStatus === 'failed') {
            return res.status(500).json({ error: "Failed to publish to Instagram, but row was added to sheet as 'failed'." });
        }

        return res.status(200).json({
            success: true,
            message: action === 'publish' ? `Post published and added to sheet successfully` : `Post scheduled in sheet successfully`,
            creationId,
            status: finalStatus
        });

    } catch (error: any) {
        console.error("Webhook job failed:", error);
        return res.status(500).json({ error: error.message });
    }
}
