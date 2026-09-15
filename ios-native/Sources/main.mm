#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static UIColor *R360Background(void) {
    return [UIColor colorWithRed:0.035 green:0.043 blue:0.055 alpha:1.0];
}

static UIColor *R360Panel(void) {
    return [UIColor colorWithRed:0.075 green:0.086 blue:0.105 alpha:1.0];
}

@interface R360ViewController : UIViewController <UIDocumentPickerDelegate>
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UILabel *detailLabel;
@end

@implementation R360ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = R360Background();

    UILabel *title = [[UILabel alloc] init];
    title.translatesAutoresizingMaskIntoConstraints = NO;
    title.text = @"Render360 Portal";
    title.textColor = UIColor.whiteColor;
    title.font = [UIFont systemFontOfSize:34 weight:UIFontWeightBold];

    UILabel *subtitle = [[UILabel alloc] init];
    subtitle.translatesAutoresizingMaskIntoConstraints = NO;
    subtitle.text = @"Native iOS bootstrap • arm64 • no WebAssembly";
    subtitle.textColor = [UIColor colorWithWhite:0.72 alpha:1.0];
    subtitle.font = [UIFont monospacedSystemFontOfSize:15 weight:UIFontWeightRegular];

    UIView *panel = [[UIView alloc] init];
    panel.translatesAutoresizingMaskIntoConstraints = NO;
    panel.backgroundColor = R360Panel();
    panel.layer.cornerRadius = 18;

    UILabel *status = [[UILabel alloc] init];
    status.translatesAutoresizingMaskIntoConstraints = NO;
    status.text = @"N0 native host is running.";
    status.textColor = UIColor.whiteColor;
    status.font = [UIFont systemFontOfSize:20 weight:UIFontWeightSemibold];
    self.statusLabel = status;

    UILabel *detail = [[UILabel alloc] init];
    detail.translatesAutoresizingMaskIntoConstraints = NO;
    detail.numberOfLines = 0;
    detail.text = @"Next gate: choose a legally owned Portal folder. This bootstrap verifies portal/gameinfo.txt and counts VPKs. Retail game data is never bundled into the IPA.";
    detail.textColor = [UIColor colorWithWhite:0.78 alpha:1.0];
    detail.font = [UIFont systemFontOfSize:15 weight:UIFontWeightRegular];
    self.detailLabel = detail;

    UIButton *importButton = [UIButton buttonWithType:UIButtonTypeSystem];
    importButton.translatesAutoresizingMaskIntoConstraints = NO;
    [importButton setTitle:@"Choose Portal Folder" forState:UIControlStateNormal];
    importButton.titleLabel.font = [UIFont systemFontOfSize:18 weight:UIFontWeightSemibold];
    importButton.backgroundColor = UIColor.whiteColor;
    [importButton setTitleColor:[UIColor colorWithRed:0.05 green:0.08 blue:0.12 alpha:1.0] forState:UIControlStateNormal];
    importButton.layer.cornerRadius = 12;
    importButton.contentEdgeInsets = UIEdgeInsetsMake(13, 18, 13, 18);
    [importButton addTarget:self action:@selector(importPortalFolder:) forControlEvents:UIControlEventTouchUpInside];

    UILabel *footer = [[UILabel alloc] init];
    footer.translatesAutoresizingMaskIntoConstraints = NO;
    footer.numberOfLines = 0;
    footer.text = @"Roadmap: SDL2 → native Source libraries → static module registry → VPK I/O → renderer → background1 → chamber 00 → touch/controller → current-map-only transitions.";
    footer.textColor = [UIColor colorWithWhite:0.55 alpha:1.0];
    footer.font = [UIFont monospacedSystemFontOfSize:13 weight:UIFontWeightRegular];

    [self.view addSubview:title];
    [self.view addSubview:subtitle];
    [self.view addSubview:panel];
    [panel addSubview:status];
    [panel addSubview:detail];
    [panel addSubview:importButton];
    [self.view addSubview:footer];

    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [title.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:28],
        [title.topAnchor constraintEqualToAnchor:safe.topAnchor constant:24],
        [subtitle.leadingAnchor constraintEqualToAnchor:title.leadingAnchor],
        [subtitle.topAnchor constraintEqualToAnchor:title.bottomAnchor constant:6],

        [panel.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:28],
        [panel.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-28],
        [panel.topAnchor constraintEqualToAnchor:subtitle.bottomAnchor constant:22],

        [status.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor constant:22],
        [status.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor constant:-22],
        [status.topAnchor constraintEqualToAnchor:panel.topAnchor constant:20],
        [detail.leadingAnchor constraintEqualToAnchor:status.leadingAnchor],
        [detail.trailingAnchor constraintEqualToAnchor:status.trailingAnchor],
        [detail.topAnchor constraintEqualToAnchor:status.bottomAnchor constant:10],
        [importButton.leadingAnchor constraintEqualToAnchor:status.leadingAnchor],
        [importButton.topAnchor constraintEqualToAnchor:detail.bottomAnchor constant:18],
        [importButton.bottomAnchor constraintEqualToAnchor:panel.bottomAnchor constant:-20],

        [footer.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor],
        [footer.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor],
        [footer.topAnchor constraintEqualToAnchor:panel.bottomAnchor constant:18],
        [footer.bottomAnchor constraintLessThanOrEqualToAnchor:safe.bottomAnchor constant:-16]
    ]];
}

- (void)importPortalFolder:(id)sender {
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
        initForOpeningContentTypes:@[UTTypeFolder]
        asCopy:NO];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    NSURL *root = urls.firstObject;
    if (!root) {
        return;
    }

    BOOL scoped = [root startAccessingSecurityScopedResource];
    @try {
        NSFileManager *fm = NSFileManager.defaultManager;
        NSURL *gameInfo = [root URLByAppendingPathComponent:@"portal/gameinfo.txt"];
        NSURL *portalDir = [root URLByAppendingPathComponent:@"portal" isDirectory:YES];
        NSURL *hl2Dir = [root URLByAppendingPathComponent:@"hl2" isDirectory:YES];
        NSURL *platformDir = [root URLByAppendingPathComponent:@"platform" isDirectory:YES];

        BOOL portalIsDir = NO;
        BOOL hl2IsDir = NO;
        BOOL platformIsDir = NO;
        BOOL hasPortal = [fm fileExistsAtPath:portalDir.path isDirectory:&portalIsDir] && portalIsDir;
        BOOL hasHL2 = [fm fileExistsAtPath:hl2Dir.path isDirectory:&hl2IsDir] && hl2IsDir;
        BOOL hasPlatform = [fm fileExistsAtPath:platformDir.path isDirectory:&platformIsDir] && platformIsDir;
        BOOL hasGameInfo = [fm fileExistsAtPath:gameInfo.path];

        NSUInteger vpkCount = 0;
        if (hasPortal) {
            NSDirectoryEnumerator<NSURL *> *enumerator = [fm enumeratorAtURL:portalDir
                                                  includingPropertiesForKeys:nil
                                                                     options:NSDirectoryEnumerationSkipsHiddenFiles
                                                                errorHandler:^BOOL(NSURL *url, NSError *error) {
                return YES;
            }];
            for (NSURL *url in enumerator) {
                if ([url.pathExtension.lowercaseString isEqualToString:@"vpk"]) {
                    ++vpkCount;
                }
            }
        }

        if (hasGameInfo && hasPortal && hasHL2 && hasPlatform && vpkCount > 0) {
            self.statusLabel.text = @"Portal folder verified.";
            self.detailLabel.text = [NSString stringWithFormat:
                @"Found portal/gameinfo.txt, portal/, hl2/, platform/, and %lu VPK files. N4 will persist/import the authorized data for native Source I/O.",
                (unsigned long)vpkCount];
        } else {
            self.statusLabel.text = @"That folder is not a complete Portal root.";
            self.detailLabel.text = [NSString stringWithFormat:
                @"Need portal/gameinfo.txt plus portal/, hl2/, platform/ and VPKs. Results: gameinfo=%@ portal=%@ hl2=%@ platform=%@ vpks=%lu",
                hasGameInfo ? @"yes" : @"no",
                hasPortal ? @"yes" : @"no",
                hasHL2 ? @"yes" : @"no",
                hasPlatform ? @"yes" : @"no",
                (unsigned long)vpkCount];
        }
    } @finally {
        if (scoped) {
            [root stopAccessingSecurityScopedResource];
        }
    }
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
    return UIInterfaceOrientationMaskLandscape;
}

- (BOOL)prefersStatusBarHidden {
    return YES;
}

@end

@interface R360AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation R360AppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [[R360ViewController alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(R360AppDelegate.class));
    }
}
