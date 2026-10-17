export class HttpError extends Error {
  constructor(status, message, code = 'request_failed') { super(message); this.status = status; this.code = code; }
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers}});
}
export async function readJSON(request, maxBytes = 16384) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'Ожидается JSON.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new HttpError(413,'Запрос слишком большой.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400,'Пустой запрос.');
  const chunks=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel();throw new HttpError(413,'Запрос слишком большой.');}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw 0;return result;}catch{throw new HttpError(400,'Некорректный JSON.');}
}
