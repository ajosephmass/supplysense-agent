import type { NextApiRequest, NextApiResponse } from 'next';
interface AgentCoreResponse {
    success: boolean;
    result?: any;
    error?: string;
    message?: string;
}
export default function handler(req: NextApiRequest, res: NextApiResponse<AgentCoreResponse>): Promise<void>;
export {};
