import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
    password: string,
    hash: string
): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

export function isBcryptHash(password: string): boolean {
    return password.startsWith('$2a$')
        || password.startsWith('$2b$')
        || password.startsWith('$2y$');
}