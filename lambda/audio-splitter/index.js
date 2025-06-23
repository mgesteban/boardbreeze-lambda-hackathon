const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

// Initialize AWS services
const s3 = new AWS.S3();
const transcribe = new AWS.TranscribeService();

// Promisify fs functions
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

/**
 * AWS Lambda function for splitting large audio files
 * Triggered by S3 events when audio files are uploaded
 */
exports.handler = async (event) => {
    console.log('Lambda function started', JSON.stringify(event, null, 2));
    
    try {
        // Extract S3 information from the event
        const { s3Key, bucketName } = event;
        
        if (!s3Key || !bucketName) {
            throw new Error('Missing required parameters: s3Key and bucketName');
        }
        
        console.log(`Processing file: ${s3Key} from bucket: ${bucketName}`);
        
        // Step 1: Analyze the audio file
        const audioInfo = await analyzeAudioFile(s3Key, bucketName);
        console.log('Audio analysis result:', audioInfo);
        
        // Check if file needs splitting (> 4 hours)
        const fourHoursInSeconds = 4 * 60 * 60;
        
        if (audioInfo.duration <= fourHoursInSeconds) {
            console.log('File is under 4 hours, no splitting needed');
            return {
                statusCode: 200,
                body: {
                    status: 'no-split-needed',
                    duration: audioInfo.duration,
                    message: 'File is within AWS Transcribe limits'
                }
            };
        }
        
        // Step 2: Split the audio file
        console.log('File exceeds 4 hours, starting split process');
        const segments = await splitAudioFile(s3Key, bucketName, audioInfo.duration);
        
        // Step 3: Upload segments back to S3
        const segmentUrls = await uploadSegments(segments, bucketName, s3Key);
        
        // Step 4: Clean up temporary files
        await cleanupTempFiles(segments);
        
        console.log(`Successfully split file into ${segments.length} segments`);
        
        return {
            statusCode: 200,
            body: {
                status: 'split-complete',
                originalFile: s3Key,
                segments: segmentUrls.length,
                segmentUrls: segmentUrls,
                originalDuration: audioInfo.duration
            }
        };
        
    } catch (error) {
        console.error('Lambda function error:', error);
        
        return {
            statusCode: 500,
            body: {
                status: 'error',
                message: error.message,
                stack: error.stack
            }
        };
    }
};

/**
 * Analyze audio file to get duration and metadata
 */
async function analyzeAudioFile(s3Key, bucketName) {
    return new Promise(async (resolve, reject) => {
        try {
            // Download file to temporary location
            const tempInputPath = `/tmp/input_${Date.now()}.mp3`;
            
            const s3Object = await s3.getObject({
                Bucket: bucketName,
                Key: s3Key
            }).promise();
            
            await writeFile(tempInputPath, s3Object.Body);
            
            // Use ffmpeg to get audio information
            ffmpeg.ffprobe(tempInputPath, (err, metadata) => {
                if (err) {
                    console.error('FFprobe error:', err);
                    reject(err);
                    return;
                }
                
                const duration = metadata.format.duration;
                const size = metadata.format.size;
                
                // Clean up temp file
                fs.unlink(tempInputPath, (unlinkErr) => {
                    if (unlinkErr) console.warn('Failed to delete temp file:', unlinkErr);
                });
                
                resolve({
                    duration: parseFloat(duration),
                    size: parseInt(size),
                    format: metadata.format.format_name
                });
            });
            
        } catch (error) {
            console.error('Error analyzing audio file:', error);
            reject(error);
        }
    });
}

/**
 * Split audio file into segments
 */
async function splitAudioFile(s3Key, bucketName, totalDuration) {
    const segmentDuration = 3.5 * 60 * 60; // 3.5 hours in seconds
    const segments = [];
    
    // Download the original file
    const tempInputPath = `/tmp/input_${Date.now()}.mp3`;
    
    const s3Object = await s3.getObject({
        Bucket: bucketName,
        Key: s3Key
    }).promise();
    
    await writeFile(tempInputPath, s3Object.Body);
    
    // Calculate number of segments needed
    const numSegments = Math.ceil(totalDuration / segmentDuration);
    console.log(`Splitting into ${numSegments} segments`);
    
    // Create segments
    for (let i = 0; i < numSegments; i++) {
        const startTime = i * segmentDuration;
        const segmentPath = `/tmp/segment_${i}_${Date.now()}.mp3`;
        
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputPath)
                .seekInput(startTime)
                .duration(segmentDuration)
                .audioCodec('mp3')
                .on('end', () => {
                    console.log(`Segment ${i + 1} created successfully`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`Error creating segment ${i + 1}:`, err);
                    reject(err);
                })
                .save(segmentPath);
        });
        
        segments.push({
            index: i,
            path: segmentPath,
            startTime: startTime,
            duration: Math.min(segmentDuration, totalDuration - startTime)
        });
    }
    
    // Clean up original temp file
    await unlink(tempInputPath);
    
    return segments;
}

/**
 * Upload segments back to S3
 */
async function uploadSegments(segments, bucketName, originalS3Key) {
    const segmentUrls = [];
    const baseKey = originalS3Key.replace(/\.[^/.]+$/, ''); // Remove extension
    
    for (const segment of segments) {
        const segmentKey = `${baseKey}_segment_${segment.index}.mp3`;
        
        try {
            const segmentData = await readFile(segment.path);
            
            await s3.putObject({
                Bucket: bucketName,
                Key: segmentKey,
                Body: segmentData,
                ContentType: 'audio/mpeg',
                Metadata: {
                    'original-file': originalS3Key,
                    'segment-index': segment.index.toString(),
                    'segment-start-time': segment.startTime.toString(),
                    'segment-duration': segment.duration.toString()
                }
            }).promise();
            
            const segmentUrl = `s3://${bucketName}/${segmentKey}`;
            segmentUrls.push({
                url: segmentUrl,
                key: segmentKey,
                index: segment.index,
                startTime: segment.startTime,
                duration: segment.duration
            });
            
            console.log(`Uploaded segment ${segment.index} to ${segmentKey}`);
            
        } catch (error) {
            console.error(`Error uploading segment ${segment.index}:`, error);
            throw error;
        }
    }
    
    return segmentUrls;
}

/**
 * Clean up temporary files
 */
async function cleanupTempFiles(segments) {
    for (const segment of segments) {
        try {
            await unlink(segment.path);
            console.log(`Cleaned up temp file: ${segment.path}`);
        } catch (error) {
            console.warn(`Failed to clean up temp file ${segment.path}:`, error);
        }
    }
}

/**
 * Trigger transcription jobs for segments (optional)
 */
async function triggerTranscriptionJobs(segmentUrls) {
    const transcriptionJobs = [];
    
    for (const segment of segmentUrls) {
        const jobName = `boardbreeze-segment-${segment.index}-${Date.now()}`;
        
        try {
            const params = {
                TranscriptionJobName: jobName,
                Media: {
                    MediaFileUri: segment.url
                },
                MediaFormat: 'mp3',
                LanguageCode: 'en-US',
                OutputBucketName: segment.url.split('/')[2], // Extract bucket name
                OutputKey: `transcriptions/${jobName}.json`
            };
            
            const result = await transcribe.startTranscriptionJob(params).promise();
            
            transcriptionJobs.push({
                jobName: jobName,
                segmentIndex: segment.index,
                status: 'STARTED',
                transcriptionJob: result.TranscriptionJob
            });
            
            console.log(`Started transcription job for segment ${segment.index}: ${jobName}`);
            
        } catch (error) {
            console.error(`Error starting transcription job for segment ${segment.index}:`, error);
            // Don't throw here - we want to continue with other segments
        }
    }
    
    return transcriptionJobs;
}
