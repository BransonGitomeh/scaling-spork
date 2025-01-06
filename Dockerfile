# Use an official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and yarn.lock to the working directory
COPY package.json yarn.lock ./

# Install dependencies using yarn
RUN yarn install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on (if applicable)
EXPOSE 3000

# Command to run your Node.js application
CMD ["node", "your-app-file.js"]