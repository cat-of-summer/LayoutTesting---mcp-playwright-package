/**
 * Контекст вызова инструмента: какой сервер MCP (то есть какой клиент) его прислал.
 *
 * Нужен там, где стенду посреди работы надо спросить человека, а не агента: копию файла Figma
 * в черновики команды подтверждает человек формой клиента (elicitation), и агент в этом обмене не
 * участвует — его контекст не засоряется вопросом, на который он всё равно не ответит сам. Код
 * глубоко внутри (редактор Figma) о сервере не знает и берёт его отсюда.
 *
 * Под HTTP-транспортом сервер создаётся на каждого клиента, поэтому глобальной переменной здесь
 * не обойтись: вопрос ушёл бы не тому клиенту.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Обернуть регистрацию инструментов: каждый обработчик выполняется в контексте своего сервера. */
export function bindRequests(server) {
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    register(name, config, (...args) => storage.run({ server, tool: name }, () => handler(...args)));
}

/**
 * Спросить человека формой клиента. Ответ — { action, content }: accept с заполненными полями,
 * decline и cancel — человек отказался или закрыл форму, unsupported — спросить нечем (клиент
 * без elicitation или вызов вне инструмента).
 */
export async function askHuman(message, requestedSchema) {
  const ctx = storage.getStore();
  const low = ctx?.server?.server;
  if (!low?.getClientCapabilities?.()?.elicitation) return { action: 'unsupported' };
  try {
    const res = await low.elicitInput({ message, requestedSchema });
    return { action: res.action, content: res.content ?? {} };
  } catch (err) {
    return { action: 'unsupported', error: err.message };
  }
}
