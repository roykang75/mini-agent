export interface EchoInput {
  message: string;
}

export async function execute(args: EchoInput): Promise<string> {
  return `Echo: ${args.message}`;
}