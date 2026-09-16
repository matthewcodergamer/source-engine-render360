#import "R360BootstrapViewController.h"

#import "R360Diagnostics.h"
#import "R360PortalValidator.h"

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static UIColor *R360Background(void) {
    return [UIColor colorWithRed:0.035 green:0.043 blue:0.055 alpha:1.0];
}

static UIColor *R360Panel(void) {
    return [UIColor colorWithRed:0.075 green:0.086 blue:0.105 alpha:1.0];
}

@interface R360BootstrapViewController () <UIDocumentPickerDelegate>
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UILabel *detailLabel;
@property(nonatomic, strong) UILabel *diagnosticsLabel;
@end

@implementation R360BootstrapViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = R360Background();

    UIScrollView *scrollView = [[UIScrollView alloc] init];
    scrollView.translatesAutoresizingMaskIntoConstraints = NO;
    scrollView.alwaysBounceVertical = YES;

    UIStackView *stack = [[UIStackView alloc] init];
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = 12;

    UILabel *title = [[UILabel alloc] init];
    title.text = @"Render360 Portal";
    title.textColor = UIColor.whiteColor;
    title.font = [UIFont systemFontOfSize:32 weight:UIFontWeightBold];

    UILabel *subtitle = [[UILabel alloc] init];
    subtitle.text = @"Native iOS N0 bootstrap • arm64 • no WebAssembly";
    subtitle.textColor = [UIColor colorWithWhite:0.72 alpha:1.0];
    subtitle.font = [UIFont monospacedSystemFontOfSize:14 weight:UIFontWeightRegular];

    UIView *panel = [[UIView alloc] init];
    panel.translatesAutoresizingMaskIntoConstraints = NO;
    panel.backgroundColor = R360Panel();
    panel.layer.cornerRadius = 16;

    UIStackView *panelStack = [[UIStackView alloc] init];
    panelStack.translatesAutoresizingMaskIntoConstraints = NO;
    panelStack.axis = UILayoutConstraintAxisVertical;
    panelStack.spacing = 10;

    UILabel *status = [[UILabel alloc] init];
    status.numberOfLines = 0;
    status.text = @"Portal data is not configured.";
    status.textColor = UIColor.whiteColor;
    status.font = [UIFont systemFontOfSize:20 weight:UIFontWeightSemibold];
    self.statusLabel = status;

    UILabel *detail = [[UILabel alloc] init];
    detail.numberOfLines = 0;
    detail.text = @"Choose a legally owned Portal root when you are ready. Missing game data is a normal setup state and never a fatal bootstrap error.";
    detail.textColor = [UIColor colorWithWhite:0.78 alpha:1.0];
    detail.font = [UIFont systemFontOfSize:15 weight:UIFontWeightRegular];
    self.detailLabel = detail;

    UIButtonConfiguration *buttonConfiguration = [UIButtonConfiguration filledButtonConfiguration];
    buttonConfiguration.title = @"Choose Portal Folder";
    buttonConfiguration.baseBackgroundColor = UIColor.whiteColor;
    buttonConfiguration.baseForegroundColor = [UIColor colorWithRed:0.05 green:0.08 blue:0.12 alpha:1.0];
    buttonConfiguration.contentInsets = NSDirectionalEdgeInsetsMake(12, 18, 12, 18);
    UIButton *importButton = [UIButton buttonWithConfiguration:buttonConfiguration primaryAction:nil];
    [importButton addTarget:self action:@selector(importPortalFolder:) forControlEvents:UIControlEventTouchUpInside];

    UILabel *diagnosticsHeading = [[UILabel alloc] init];
    diagnosticsHeading.text = @"Bootstrap diagnostics";
    diagnosticsHeading.textColor = UIColor.whiteColor;
    diagnosticsHeading.font = [UIFont systemFontOfSize:16 weight:UIFontWeightSemibold];

    UILabel *diagnostics = [[UILabel alloc] init];
    diagnostics.numberOfLines = 0;
    diagnostics.textColor = [UIColor colorWithWhite:0.66 alpha:1.0];
    diagnostics.font = [UIFont monospacedSystemFontOfSize:12 weight:UIFontWeightRegular];
    self.diagnosticsLabel = diagnostics;

    UILabel *footer = [[UILabel alloc] init];
    footer.numberOfLines = 0;
    footer.text = @"This phase validates only the native bootstrap and a user-selected folder. It does not copy VPKs, mount Source filesystems, render Portal, or persist authorization yet.";
    footer.textColor = [UIColor colorWithWhite:0.55 alpha:1.0];
    footer.font = [UIFont monospacedSystemFontOfSize:12 weight:UIFontWeightRegular];

    [self.view addSubview:scrollView];
    [scrollView addSubview:stack];
    [stack addArrangedSubview:title];
    [stack addArrangedSubview:subtitle];
    [stack addArrangedSubview:panel];
    [panel addSubview:panelStack];
    [panelStack addArrangedSubview:status];
    [panelStack addArrangedSubview:detail];
    [panelStack addArrangedSubview:importButton];
    [stack addArrangedSubview:diagnosticsHeading];
    [stack addArrangedSubview:diagnostics];
    [stack addArrangedSubview:footer];

    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [scrollView.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
        [scrollView.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
        [scrollView.topAnchor constraintEqualToAnchor:safe.topAnchor],
        [scrollView.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor],

        [stack.leadingAnchor constraintEqualToAnchor:scrollView.contentLayoutGuide.leadingAnchor constant:24],
        [stack.trailingAnchor constraintEqualToAnchor:scrollView.contentLayoutGuide.trailingAnchor constant:-24],
        [stack.topAnchor constraintEqualToAnchor:scrollView.contentLayoutGuide.topAnchor constant:18],
        [stack.bottomAnchor constraintEqualToAnchor:scrollView.contentLayoutGuide.bottomAnchor constant:-18],
        [stack.widthAnchor constraintEqualToAnchor:scrollView.frameLayoutGuide.widthAnchor constant:-48],

        [panelStack.leadingAnchor constraintEqualToAnchor:panel.leadingAnchor constant:18],
        [panelStack.trailingAnchor constraintEqualToAnchor:panel.trailingAnchor constant:-18],
        [panelStack.topAnchor constraintEqualToAnchor:panel.topAnchor constant:16],
        [panelStack.bottomAnchor constraintEqualToAnchor:panel.bottomAnchor constant:-16]
    ]];

    [NSNotificationCenter.defaultCenter addObserver:self
                                           selector:@selector(diagnosticsDidChange:)
                                               name:R360DiagnosticsDidChangeNotification
                                             object:R360Diagnostics.sharedDiagnostics];
    [NSNotificationCenter.defaultCenter addObserver:self
                                           selector:@selector(applicationDidReceiveMemoryWarning:)
                                               name:UIApplicationDidReceiveMemoryWarningNotification
                                             object:nil];

    R360Diagnostics *diagnosticsState = R360Diagnostics.sharedDiagnostics;
    [diagnosticsState setCheckpoint:@"ui-ready"];
    [diagnosticsState setGameDataState:@"not configured"];
    [diagnosticsState setLatestError:nil];
    [diagnosticsState setCheckpoint:@"game-data-not-configured"];
    [self refreshDiagnostics];
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)diagnosticsDidChange:(NSNotification *)notification {
    [self refreshDiagnostics];
}

- (void)applicationDidReceiveMemoryWarning:(NSNotification *)notification {
    [R360Diagnostics.sharedDiagnostics recordMemoryWarning];
}

- (void)refreshDiagnostics {
    if (!self.isViewLoaded) {
        return;
    }
    self.diagnosticsLabel.text = [R360Diagnostics.sharedDiagnostics formattedSummary];
}

- (void)importPortalFolder:(id)sender {
    R360Diagnostics *diagnostics = R360Diagnostics.sharedDiagnostics;
    [diagnostics setLatestError:nil];
    [diagnostics setCheckpoint:@"import-picker-open"];

    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
        initForOpeningContentTypes:@[UTTypeFolder]
        asCopy:NO];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    [R360Diagnostics.sharedDiagnostics setCheckpoint:@"import-picker-cancelled"];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    NSURL *rootURL = urls.firstObject;
    if (!rootURL) {
        [R360Diagnostics.sharedDiagnostics setLatestError:@"document picker returned no URL"];
        [R360Diagnostics.sharedDiagnostics setCheckpoint:@"candidate-root-invalid"];
        return;
    }

    R360Diagnostics *diagnostics = R360Diagnostics.sharedDiagnostics;
    [diagnostics setCheckpoint:@"candidate-root-validating"];
    [diagnostics setGameDataState:@"validating selected root"];

    R360PortalValidationResult *result = [R360PortalValidator validateCandidateRootURL:rootURL];
    if (result.isValid) {
        self.statusLabel.text = @"Portal folder verified for N0.";
        self.detailLabel.text = result.detail;
        [diagnostics setGameDataState:@"candidate root valid (temporary access only)"];
        [diagnostics setLatestError:nil];
        [diagnostics setCheckpoint:@"candidate-root-valid"];
    } else {
        self.statusLabel.text = @"That folder is not a complete Portal root.";
        self.detailLabel.text = result.detail;
        [diagnostics setGameDataState:@"candidate root invalid"];
        [diagnostics setLatestError:result.errorReason ?: @"Portal root validation failed"];
        [diagnostics setCheckpoint:@"candidate-root-invalid"];
    }
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
    return UIInterfaceOrientationMaskLandscape;
}

- (BOOL)prefersStatusBarHidden {
    return YES;
}

@end
