// test-webhook.ts
// Run this script using ts-node or tsx to test the newly created webhook
// Example: npx tsx test-webhook.ts
// MAKE SURE YOUR LOCAL DEVELOPMENT SERVER IS RUNNING FIRST! (e.g. npm run dev)

const webhookSecret = process.env.WEBHOOK_SECRET || "your_secret_here"; // Replace with your actual WEBHOOK_SECRET from .env
const testProfileId = "your_profile_id";  // Replace with an actual profile ID from your Sheets
const isLocal = true;

// Ensure this matches the port your dev server is running on (usually 3000, 5173, etc.)
const PORT = 3000;

const endpoint = isLocal
    ? `http://localhost:${PORT}/api/webhooks/manual`
    : `https://your-domain.vercel.app/api/webhooks/manual`;

async function testWebhook() {
    console.log(`Sending webhook test to: ${endpoint}`);
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${webhookSecret}`
            },
            body: JSON.stringify({
                profileId: testProfileId,
                action: "schedule", // use "publish" if you want it to post immediately to Instagram
                date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
                time: "12:00",
                theme: "Test Webhook",
                title: "Hook Example",
                caption: "This is a test post from the webhook! #test",
                script: "Testing script",
                cta: "Click link in bio",
                // Media URLs (Array of strings or a comma separated string)
                mediaUrls: [
                    "https://ik.imagekit.io/demo/medium_cafe_B1iTdD0C.jpg"
                ]
            })
        });

        const data = await res.json();
        console.log("Response Status:", res.status);
        console.log("Response Body:", data);
    } catch (err: any) {
        if (err.cause?.code === 'ECONNREFUSED') {
            console.error("\n❌ CONNECTION REFUSED: Your local development server is not running, or it's running on a different port than", PORT);
            console.error("Please run 'npm run dev' or 'vercel dev' in another terminal first!\n");
        } else {
            console.error("Test failed:", err);
        }
    }
}

testWebhook();
