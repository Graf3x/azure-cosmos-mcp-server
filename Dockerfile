# Stage 1: Build the application
FROM node:23-slim AS builder
WORKDIR /app

# Copy package files and tsconfig first
COPY package.json package-lock.json* tsconfig.json ./

# Copy the rest of the source code
COPY . .

# Install all dependencies (including dev) and build
RUN npm install
RUN npm run build

# Stage 2: Create the final production image
FROM node:23-slim
WORKDIR /app


COPY package.json package-lock.json* ./
# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
ARG PORT=8000
ENV PORT=${PORT}

EXPOSE ${PORT}

# Command to run the application (uses the start script from package.json)
CMD ["npm", "start"]
