#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

typedef void (*FrameCallback)(const uint8_t* data, size_t len, void* user_data);

@interface MacCameraCapture : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property (strong, nonatomic) AVCaptureSession *session;
@property (assign, nonatomic) FrameCallback callback;
@property (assign, nonatomic) void* userData;
@property (strong, nonatomic) dispatch_queue_t queue;
@end

@implementation MacCameraCapture

- (id)initWithWidth:(uint32_t)width height:(uint32_t)height fps:(uint32_t)fps callback:(FrameCallback)callback userData:(void*)userData {
    self = [super init];
    if (self) {
        _callback = callback;
        _userData = userData;
        _queue = dispatch_queue_create("com.viewport.camera", DISPATCH_QUEUE_SERIAL);
        
        _session = [[AVCaptureSession alloc] init];
        [_session beginConfiguration];
        if (width >= 1280 && height >= 720) {
            _session.sessionPreset = AVCaptureSessionPreset1280x720;
        } else {
            _session.sessionPreset = AVCaptureSessionPreset640x480;
        }
        
        AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
        if (!device) {
            [_session commitConfiguration];
            return nil;
        }
        
        NSError *error = nil;
        AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
        if (error || !input || ![_session canAddInput:input]) {
            [_session commitConfiguration];
            return nil;
        }
        [_session addInput:input];
        
        AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
        output.alwaysDiscardsLateVideoFrames = YES;
        output.videoSettings = @{
            (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA)
        };
        [output setSampleBufferDelegate:self queue:_queue];
        
        if ([_session canAddOutput:output]) {
            [_session addOutput:output];
        }
        
        [_session commitConfiguration];
    }
    return self;
}

- (void)start {
    if (!self.session.isRunning) {
        [self.session startRunning];
    }
}

- (void)stop {
    if (self.session.isRunning) {
        [self.session stopRunning];
    }
}

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {
    if (!_callback) return;
    
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;
    
    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    void *baseAddress = CVPixelBufferGetBaseAddress(imageBuffer);
    size_t width = CVPixelBufferGetWidth(imageBuffer);
    size_t height = CVPixelBufferGetHeight(imageBuffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer);
    
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(baseAddress, width, height, 8, bytesPerRow, colorSpace,
                                                 kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    CGImageRef cgImage = CGBitmapContextCreateImage(context);
    
    NSMutableData *jpegData = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)jpegData,
                                                                         CFSTR("public.jpeg"), 1, NULL);
    if (destination && cgImage) {
        NSDictionary *options = @{
            (id)kCGImageDestinationLossyCompressionQuality: @(0.75)
        };
        CGImageDestinationAddImage(destination, cgImage, (__bridge CFDictionaryRef)options);
        if (CGImageDestinationFinalize(destination)) {
            _callback(jpegData.bytes, jpegData.length, _userData);
        }
        CFRelease(destination);
    }
    
    if (cgImage) CGImageRelease(cgImage);
    CGContextRelease(context);
    CGColorSpaceRelease(colorSpace);
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
}

@end

void* mac_camera_create(uint32_t width, uint32_t height, uint32_t fps, FrameCallback callback, void* user_data) {
    MacCameraCapture *capture = [[MacCameraCapture alloc] initWithWidth:width height:height fps:fps callback:callback userData:user_data];
    if (!capture) return NULL;
    return (void*)CFBridgingRetain(capture);
}

void mac_camera_start(void* handle) {
    if (!handle) return;
    MacCameraCapture *capture = (__bridge MacCameraCapture*)handle;
    [capture start];
}

void mac_camera_stop(void* handle) {
    if (!handle) return;
    MacCameraCapture *capture = (__bridge MacCameraCapture*)handle;
    [capture stop];
}

void mac_camera_destroy(void* handle) {
    if (!handle) return;
    MacCameraCapture *capture = (__bridge_transfer MacCameraCapture*)handle;
    [capture stop];
}
