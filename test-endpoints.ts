import { spawn } from 'child_process'
import http from 'http'

// Simple test script to verify endpoints
const BASE_URL = 'http://localhost:3000'

const endpoints = [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/puntos-venta' },
    { method: 'GET', path: '/catalogo/servicios' },
    { method: 'GET', path: '/catalogo/productos' },
    // Methods requiring body will be tested separately or crudely here
]

async function testEndpoint(method: string, path: string) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE_URL}${path}`, { method }, (res) => {
            let data = ''
            res.on('data', (chunk) => data += chunk)
            res.on('end', () => {
                console.log(`[${method}] ${path} -> ${res.statusCode}`)
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    console.log('Response preview:', data.substring(0, 100))
                } else {
                    console.error('Error response:', data)
                }
                resolve(res.statusCode)
            })
        })
        req.on('error', reject)
        req.end()
    })
}

async function runTests() {
    console.log('Waiting for server to start...')
    // Wait a bit for server to start if we were spawning it, but here we assume it's running or we run this after

    for (const endpoint of endpoints) {
        try {
            await testEndpoint(endpoint.method, endpoint.path)
        } catch (e) {
            console.error(`Failed ${endpoint.path}`, e)
        }
    }
}

runTests()
