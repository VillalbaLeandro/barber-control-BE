import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const connectionString = process.env.DATABASE_URL_APP || process.env.DATABASE_URL

if (!connectionString) {
    throw new Error('DATABASE_URL_APP/DATABASE_URL is not defined in .env file')
}

const sql = postgres(connectionString, {
    prepare: false,
    max: 1,
})

export default sql
