## Generate Image

You can generate images using the Gemini API and send them directly to the current Telegram chat.

### When to Use

- User explicitly asks for an image, picture, drawing, illustration, or visual
- User asks to visualize, sketch, or create something visual
- User says "show me what X looks like" or "draw X"

Do NOT generate images unless the user clearly wants a visual. Text descriptions are fine for most requests.

### How to Use

Run the imagine script from the project root:

```bash
./scripts/imagine.sh "detailed prompt describing the image"
```

The script will:
1. Call the Gemini API to generate the image
2. Send it directly to the user's Telegram chat
3. Print a confirmation message

The `TELEGRAM_CHAT_ID` environment variable is set automatically -- the script knows which chat to send to.

### Tips

- Write detailed, descriptive prompts for better results (style, colors, composition, mood)
- If the user gives a short request like "draw a cat", expand it into a richer prompt
- If the script fails with a safety filter error, let the user know and suggest rephrasing
- If it fails with a rate limit error, wait a moment and try again
- Keep prompts under 2000 characters

### Requirements

- `GEMINI_API_KEY` must be set in `.env`
- Gemini billing must be enabled (free tier may block image generation)
