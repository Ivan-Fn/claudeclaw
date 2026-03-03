---
name: generate-image
description: This skill should be used when the user asks to "generate an image", "draw something", "create a picture", "visualize", "create an illustration", "show me what X looks like", or any request that requires producing a visual.
---

## Generate Image

Generate images using the Gemini API and send them directly to the current Telegram chat.

### When to Use

- User explicitly asks for an image, picture, drawing, illustration, or visual
- User asks to visualize, sketch, or create something visual
- User says "show me what X looks like" or "draw X"

Do NOT generate images unless the user clearly wants a visual. Text descriptions are fine for most requests.

### How to Generate

Use the Gemini API with `gemini-3.1-flash-image-preview` model for image generation. The `GOOGLE_API_KEY` environment variable is set automatically.

Write a Python script inline to generate the image and send it to Telegram:

```python
python3 -c "
from google import genai
from google.genai import types
import tempfile, subprocess, os

client = genai.Client()
response = client.models.generate_content(
    model='gemini-3.1-flash-image-preview',
    contents='YOUR PROMPT HERE',
    config=types.GenerateContentConfig(response_modalities=['TEXT', 'IMAGE'])
)

for part in response.candidates[0].content.parts:
    if part.inline_data and part.inline_data.data:
        # SDK returns raw bytes, NOT base64
        img = part.inline_data.data
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        tmp.write(img)
        tmp.close()

        # Send to Telegram
        chat_id = os.environ['TELEGRAM_CHAT_ID']
        token = [line.split('=',1)[1] for line in open('.env') if line.startswith('TELEGRAM_BOT_TOKEN=')][0].strip()
        subprocess.run(['curl', '-s', '-X', 'POST',
            f'https://api.telegram.org/bot{token}/sendPhoto',
            '-F', f'chat_id={chat_id}',
            '-F', f'photo=@{tmp.name}'], check=True)
        os.unlink(tmp.name)
        print('Image sent')
        break
"
```

The `TELEGRAM_CHAT_ID` environment variable is set automatically for every agent session.

### Important

- The `google-genai` SDK returns `part.inline_data.data` as raw `bytes`, NOT base64. Do NOT call `base64.b64decode` on it.

### Tips

- Write detailed, descriptive prompts for better results (style, colors, composition, mood)
- If the user gives a short request like "draw a cat", expand it into a richer prompt
- If generation fails with a safety filter error, tell the user and suggest rephrasing
- If it fails with a rate limit, wait a moment and try again
- Keep prompts under 2000 characters

### Requirements

- `GOOGLE_API_KEY` must be set (mapped from `GEMINI_API_KEY` in `.env`)
- `google-genai` Python package must be installed (`pip install google-genai`)
- Gemini billing must be enabled (free tier may block image generation)
