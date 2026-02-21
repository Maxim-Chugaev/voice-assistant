import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const systemPrompt = `Ты голосовой помощник. Отвечай кратко и по делу, предложениями, удобными для озвучки. Не используй списки и длинные абзацы. Язык ответа — тот же, что у пользователя.`;

/**
 * Отправка сообщения в ChatGPT и получение ответа.
 */
export async function chat(messages: Message[]): Promise<string> {
  const response = await client.chat.completions.create({
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
