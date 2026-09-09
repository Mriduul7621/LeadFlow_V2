import { JwtPayload } from '../utils/jwt.js';

declare global {
    namespace Express {
        interface Request {
            currentUser?: JwtPayload;
        }
    }
}

export {};