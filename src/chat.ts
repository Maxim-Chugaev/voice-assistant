import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY не задан. Добавьте в .env или окружение.');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const systemPrompt = `Ты голосовой помощник. Отвечай кратко и по делу, предложениями, удобными для озвучки. Не используй списки и длинные абзацы. Язык ответа — тот же, что у пользователя.`;

/**
 * Отправка сообщения в ChatGPT и получение ответа.
 */
export async function chat(messages: Message[]): Promise<string> {
  const response = await getClient().chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 500,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Пустой ответ от ChatGPT');
  }
  return content.trim();
}

/**
 * Отправка сообщения в ChatGPT с получением потокового ответа.
 */
export async function* chatStream(messages: Message[]): AsyncGenerator<string, void, unknown> {
  const stream = await getClient().chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 500,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}
