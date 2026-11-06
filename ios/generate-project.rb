#!/usr/bin/env ruby
# Regenerate after adding Swift files: ruby ios/generate-project.rb (gem install xcodeproj).
require 'xcodeproj'
require 'fileutils'
root = File.expand_path(__dir__)
project_path = File.join(root, 'RemindMe.xcodeproj')
FileUtils.rm_rf(project_path) if File.exist?(project_path)
project = Xcodeproj::Project.new(project_path)
app = project.new_target(:application, 'RemindMe', :ios, '17.0')
tests = project.new_target(:unit_test_bundle, 'RemindMeTests', :ios, '17.0')
tests.add_dependency(app)
ui_tests = project.new_target(:ui_test_bundle, 'RemindMeUITests', :ios, '17.0')
ui_tests.add_dependency(app)
[[app,'RemindMe'], [tests,'RemindMeTests'], [ui_tests,'RemindMeUITests']].each do |target, folder|
  group = project.main_group.new_group(folder, folder)
  Dir.glob(File.join(root, folder, '*.swift')).sort.each { |file| target.source_build_phase.add_file_reference(group.new_file(File.basename(file))) }
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'SWIFT_VERSION'=>'5.0', 'IPHONEOS_DEPLOYMENT_TARGET'=>'17.0', 'TARGETED_DEVICE_FAMILY'=>'1',
      'CODE_SIGN_STYLE'=>'Automatic', 'PRODUCT_BUNDLE_IDENTIFIER'=>"com.righttang.remindme#{target == app ? '' : '.' + folder.downcase}",
      'MARKETING_VERSION'=>'1.0.1', 'CURRENT_PROJECT_VERSION'=>'2', 'GENERATE_INFOPLIST_FILE'=>'YES',
      'SWIFT_EMIT_LOC_STRINGS'=>'YES'
    })
    config.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'DEBUG' if config.name == 'Debug'
    if target == app
      config.build_settings['INFOPLIST_FILE'] = 'RemindMe/Info.plist'
      config.build_settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
      config.build_settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
    elsif target == tests
      config.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/RemindMe.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/RemindMe'
      config.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
    else
      config.build_settings['TEST_TARGET_NAME'] = 'RemindMe'
    end
  end
end
assets = project.main_group.find_subpath('RemindMe').new_file('Assets.xcassets')
app.resources_build_phase.add_file_reference(assets)
project.root_object.attributes['LastUpgradeCheck'] = '2650'
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_test_target(tests)
scheme.add_test_target(ui_tests)
scheme.set_launch_target(app)
scheme.save_as(project_path, 'RemindMe', true)
puts project_path
