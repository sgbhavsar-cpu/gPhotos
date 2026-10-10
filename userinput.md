`npm run build:ui && npm run build:electron`

can we use one drive or google drive directly as network storage source so that without download we can create virtual albums, also let me know why there is two buttons for scanning photo and scanning faces, if we are scanning remote drive for thumbnail, in same pass we should recognize faces and in case remote storage is not available, thumbnail should be used to show the people album.

when we are doing brackground scanning using network storage, sometime it utilize whole bandwidth, can we add settings

- Maximum bandwidth user per network storage
- Time duration in second between two photo processing

This would help to make evyething responsive and if user working on his desktop, his network storage used for other purpose do not feel slow.

<

need rotate button on photo - list of photo screen on hover of mouse like checkbox for selection appears, When click rotate it should roate thumbnail shown on screen and wait for 2 second so may be user rotate it multiple time, after wait of 2 second, it should be implemented on source file if online and if offline, it has to queue that for when source become online.

also notice 40 second of time required to start the application which is too high, check and improve it by differing un-necessory tasks

Additionally, if I am having 2871 photo in physical folder, face scanning should run on that only but I am observing that it is showing almost double, are face scanning run on thumbnail ? it should run on original picture, for ehic it should generate full resolution jpeg file, run the face recognition and then delete it, for showing to user it should use thumbnail or original photo if storage is available.

In network storage screen, each configured storage should clearly show the progress or status of caching of thumbnail and face detection count. right now jainish is showing face detection status but not thumbnail status and photo1 shows nothing.

Loosing people name is crime as user has done manual input for that so do not loose names anyhow until user click on button reset and rescan.

I recommend to remove overall caching progress section and show that into individual configured storage section only that would serve the purpose .
===================================================================================================================================================

When open network storage it shows nothing configured and then slowely update with actual data, rather than show nothing configured, we should show 'Loading info' until info is actually loaded.

For heic images, we should enable rotate functionality and rorate only thumbnail what we have in our folder to show it properly to user, when user clicks on image and original image is loaded, it might be seen original but that works for now.

Deduplication from selected images, it should treat it as like one cluster and then try to identify best shot between selected images.

Review all code base.

- Check for error handling
- Best code practices
- Improvement for speed and responsiveness to user.
- Keep everything updated and stored whenever some progress is done.
- vusal styling consistant
- Show un-initialized or never loaded info as default stuff, rather should show 'Loading...' or some animation until info is actually loaded.

==

Remove all the 'Google' words as we can not use google word in our application description or name etc, we should use gPhotos everywhere to avoid any  copy right issue.

I try to test creating new network storage location, I have given name 'hemlata' and add it, now it shows two storage location in left side menu called hellata and other with original name of folder which big one. it should be only one.

still virtual rotate is not working for heic files.
Also I need to remove unknown or unnamed person detected from photo in single click, this is very useful when public photo detects lot of person and I know only two or three from them so individual deleting person does not make sense. Also it should store that photo fully manually verified so next face detection pass should not touch that photo and recreate deleted person on that photo until user himself click on scan faces.

When network storage is one drive and I click on folder tree, it shows direct files and in fact dowloading all the file in that structure, we should load thumbnail only and give toggle switch on top whether to load original image if required.,

Yes, now viewing photo shows thumbnail for onedrive backed library but now marking of faces are misplaced at some other location, we have to re-arrange marking.

Also need to check for responsiveness of application as it seems it stalls for few second while background scanning also, can you check and make it asynh and free fronend from lagging, run everything yourself, remove and add same storage and review why main thread is becoming non responsive.

check all the pages for mobile rendering, make button sizing proper for mobile, like photo list have half page of menu and buttons which needs to either make smaller or create button so it will only have one row in top and not fill the half page.

In photo display, show high resolution should be continue to show high resolution photos until it is toggle back, it should not be reseted when prev or next photo button is clicked.

In photo list, In Mobile, when we have select mode, action menu shown is clipped on mobile as shown in screenshot, we need to correct it for mobile display. When we have slection toggle available, we can use that, so when user click on select button, it should remove all other buttons from that group i.e. clean duplicate, rescane everything should be hide until select is toggled back, this will help to provide more space to show selection related buttons. We should redesign selection related button and select toggle itself in one line or max two line.

When user go to album and click on any album, it shows photos in that album, now if user click to open that photo it displa photo in full display. In this veiw application should remember that it is opened from album and when user click next or prev, it should show photos from that album only and not from the library.

- In Album we need image size toolbar similar to photos.
- When open photo, top toolbar is having lot of buttons but all are of different color and shapes, please make it of one shape and meaningful color if required to have colors. Use Icons only and have tooltip to show full meaning of that button icon.
- When open any person, we need buttons to be streamlined in top toolbar with icons only similar to above. Also need button to merge this person with other person.
- When reassigning a person, when we click on new person and write name, it should list or filter people of same name so it helps to prevent duplicate creation like sometime user fail to notice that person is already in list and just click on new person button.

Selection of multiple photo do not work as expected, yes it works for mouse over selection but I need that when we click ctrl button, it should help to add into selection and once photos are selected should not be deselected because of next round of selections.

If image is not having metadata embedded, Image date should be modified date and not the created date as it shows wrong.

We need to find out why albums become empty, even after rescan of folder, it should not changed

===

- In Photo details page
  - Remove top toolbar which shows fav, scan, crop buttons as it is duplicated on top toolbar also.
  - Need editable date time, update file modified time and exif infomation if possible.
  - Place name is editable but it does not update the long,lat or position on map when we modify the place name, it should try to find the location on map and if not found, it should be possible to open the map and set the location on map.
  - Need multiple file selection and update of datetime and location details.
  - Need to show list of album where this photo is added.
  - Need button to add current photo in last added two albums for example if user has added photo in alumn 'Album A' and 'Album B' then need to create button 'Add to Album A' and 'Add to album B'.
  - Tip shown should have button at right most to close it.
- In Albums
  - Albums are shown with no photos even card says 23 photos, for example 'Good Morning' album shows 23 photos but if I click, it do not show any photos.
  - Another observation that if I add one more photo to this album which do not shows photo, it will start showing all the previous photo again.
- In album display page
  - When we click "Add to Album", it shows plain list of photos, here we need different filters like date, location and if possible add 'Filter by AI' to filter photos.
  - When we create or extract cover face, it should be from original photo so that it does not look blur.
- In people and faces page
  - Number of photos below faces are wrong, for example Person 100 card shows 184 photos but when click, it shows 3 photos only.
  - When click on person card, it shows photos of person but when click esc key, it goes back to albums list. All the navigation with esc key should go back to root page which is bind with menu.
  - Sorting of the people should be done based on number of photos and not by name.
  - Only person having more than 2 photo should be listed in this list with optional toggle button in top bar to show all the people.
  - Photos of person screen is having merge button in top toolbar but when click it do not show dialogbox or may be dialog is not on the top.
  - Similarly there should be toogle button to show person with 0 photos.
- Reassign face detection
  - There should be only one big search box and then list of people, user will either directly select the person from list or type and search someone and click on it. If user write something and not found, it should display message that creating new person so both button 'Choose from existing person' and 'Create new person' can be removed.
  - There should be checkbox that 'Merge this person with selected' by which user can directly merge all the photo assigned to selected unknown person to known user, if check box is selected, current Person X's all the photos to be merged with new person and Person X which than have no photos should be removed.

====

![1790096301471](image/userinput/1790096301471.png)

Need timeline in photo galery, may be we can utilize top row where are are showing month and year but you can suggest what best we can do.

In Photo Detail  page, we need button to set this photo as cover photo. On click of this button it should show the face cropped with mark and confirmation button so if user want to adjust crop or sizing of cover photo it can be done and then confirm button to set that portion of photo as cover photo of selected person.

I have tried to 'set photo as x cover photo', yes it opens dialog box but when I click on set, it gives error.

=====

When I click person, it shows photo list of that person, in this page when we click on cover photo, it shows list of cover photos to choose from, it was working before but now it do not show any image, just showing blank.

When we click on merge, it shows dropdown of list of people, we should not show people X in that list as there is no meaning of it.

During assigning person,

- when I type partial name and press enter, it should assign automatically to first person matching that partial input
- when I click on person name, it should assign without clicking on confirmation button, this will save one click.

When merging person, it should be possible to search very same way like assigning person.

Rotate person is still not working properly, local cached thumbnail should be rotated and if original storage is not available, it should be queued.

Similar way selection process by moving mouse down is not working properly which needs to change the behaviour.

- When there is no selected images, user will press the left mouse and keep pressed, now user will move the mouse and photos should be selected as grid selection as currently being done.
- so when user wants to select next bunch of photos, there will be already selected photos and now user again press CTRL + left mouse button and keep pressed to select new set of photos, in this condition previously selected photos should not be changed or deselect or changed as it is already selected in previous action.

==

We need feature to move all the photo of one album physically to separate folder, this feature should be availabel in album screen and when click, it should show the folder browser or open folder dialogbox, user will select the folder where he wants to move the photos. It should be see that new folder selected should be in folder or sub folder of network storage or library where user is working.

Another feature we need is to select multiple photos and command to rotate photo automatically to make it up right, this should be fully automatic by identifying object or person and rotate photo so that it shows correctly in our software.

==

When user change the size of thumbnail on main screen

- If user uses top toolbar, we need to ensure that first thumbnail in top left corner should be the same after changing the size.
- If user use mouse middle scroll wheel, it needs to ensure that image under current mouse point should be the same after changing size.

It should be automatically calculate and scrolled to that position.

In photo detail / display page, if user click on face marker, default action should be bind as reasign person.

We want feature to detect specific type of photo based on description given by user for example

1. AI Generated good morning images
2. Screenshots of facebook or linkedin or xyz on mobile
3. Photo of UIP Payments
4. Photo of bills scanned
5. Photo of visiting cards

user should be able to create basic flows like identify photos with x description and then either create album of that or move all these photos to  particular folders

1. Can we show tags or description along with photo in photo detail pan ?
2. Can we use local ollama model for first pass of understanding and finding, we should also convert tags and description in RAG index, RAG database one for each library.

We need a feature in Album to create section called chapters with distinct heading for example wedding of sachin and monika may have multiple chapters by day or by event or ceremonies in a day. Design nice UI to split album in multiple chapters. While adding photo to album, it should ask for chapter where to add. For single click add to album, show album and last chapter used and if user require can click on album and select different chapter.

Chapter should have one additional photo automatically created with some text and photo or photo collage created from that chapter.

Another feature we need to plan is create video to post on social media from album or chapter. It should wizard based generation to

1. Select chapters and photos to be included.
2. Vedio size and aspect ratio, quality etc.
3. Transation effects and total time duration of generated vedio
4. Include additional slide or screen to create title etc.
5. Possibility to combine multiple photo as collage in vedio.

Create Vedio does not work properly it should,

1. Select Photos to create collage
2. now show all the photos and collage with possibility to rearrange sequence
3. Video size, aspect ratio, quality, where to store, speed of generation etc
4. When click on generate video, it should show the progress bar if possible
5. Finally when vedio is generated open the video in default application.

Create chapter button is not working, when user click on create chapter it should create new chapter with all other photo in default chapter. From list itself user should be able to select one ore more photo and drag to other chapters.

In Album view

1. When all the photos are transferred to named chapters, 'others' chapter should be mremoved.
2. It should be possible to sequence photo in chapter itself.

In Video Generation Wizard.

1. First page should show the photos with group by chapters and in same sequence as shown in album
2. There should be different style of collage should be possible, after selecting photos, it should open another popup showing multiple option to create collage.
3. For transaction effect, there should be possible to select a. random b. multiple effects c. any one.
4. For output file selection, it should automatically select the root folder of library\videos folder with album name as filename by default. In case user wants, he can change.

In photo detail page

1. need button to control whether image or thumbnail dispalyed is to display with stach and fill the entire screen or original size.

In Setting page, Local agent configuration

1. I am not able to download model by clicking download button, it shows some error, please check.

Need filter on main page to show photos which are not part of any album

In Vedio Generation wizard

1. Need one more screen to select audio or song. It should be possible to select from local disck or download from youtube using open source application from link of youtube, set start time and end time of audio from original file, repeate audio for full video.
2. Title screen design page as one of the screen in wizard, it should be fit to vedio size as I have observed that vertical vedio get title out of screen some time. Should have basic editing to create decent title screen like add photo as background, Text addition with font size, font face and color etc on title screen.
3. Same designer screen to use for end of vedio credit page optionally.

In Album screen

1. Chapter what we created is not saved permanantly, we need to save chapter info in album and sequence of photo permanantly.
2. When I click on photo in album, it shows photo full screen in photo detail page but after that when I press escape key, it goes to some different page, here we need to keep tack that from where page is open and escape key should always return user to previous page.

In album, vedio creation wizard, audio screen

1. Can we have 20 number of different music (royalty free anyway) to use which user can directly select from list. List should have name, artist and image in the list.

Main photos List

1. Possible to show photos grouped by date or folders

In Settings and Mobile

1. Rename this menu item to 'settings'
2. Convert this page into tabbed interface, tab should be on top line.

I have created one flow for testflow1 album and identify food dishes and move to another album called food dishes, when I click on run, I could not see anything. I am expecting to see the progress of identification with progress bar and detail log, better when we click on run, we open the popup which have

- Name and detail of workflow
- Soruce i.e. name of library or album
- progress bar whoing how much is completed.
- Detail log window to show the logs which should include
  - Photo Number x out of y photos : Already have description text available or trying to use local model for identification or sending photos to LLM online.

It show error if local or online llm is not configured but continue to try with what best available in hand.

In search with AI

1. We need auto complete place holders like @ to mention people and # to mention place. so when user type @ it should show auto complete kind of list of user and for # provide list of locations.
2. List should be filtered with containing so when I type bhavsar it matches sachin bhavsar as well as bhavsar tarun both.

In main page, left side navigation

1. Clean duplicate and seach with AI is already in top toolbar of photos, so we should remove it.

In photos page

1. Top toolbar starts with timeline and count of photo which is we can remove and start with library name. Library name should not be in different color chip but as standad page header. We should have Icon of photo and then white color text to show the name of library.
2. When we select and add photo to album, it shows dialogbox to select album or create new album, this dialog I think we should improve similar to person selection album so that when user click on add album button, it will focus on search texbox directly and list of all the albums with cover photo and name same like person listing, user will type to filter and if press enter, it should pick first album which is matchin or nothing is matched should create new album.

In Location editing or update

1. Everywhere we are having location, it should be possible to paste the google url from where software should pickup exact long,lat rather then trying to find location on openstreet. It should be possible to provide lable for that location which user can understand.

Smartflow

1. When I open smartflow from left side menu or selecting multiple photo and click on top toolbar button, it do not show existing flows already configured.
2. Also I have increase the token size for local model, help me to clearly understand what maximum size of photo it can handle and if it does not able to handle big size photo, can we downsample resolution or use our 500px thumbnail for this work ?

We have two AI based feature, one is AI based search where I think local LLM is doing good and second is smart flow where we need local llm + fall back to cloud llm. We should configure the smartflow separately than search with AI feature. In smart flow configuration only, we should select cloud llm to use.

Also, can we implement to check local ollama context window checking before setting batch size, so first it should check context window size and based on that no. of images in batch should be decied.

Still some of the cover photos in people list are shown as blurred, when I click to select cover photo, software should show the high quality faces to set as cover photo for person.

Edit - Crop is not working, it is jus dragging photo when try to crop. can we impllement somehting easy like drawing crop frame and user can handle any of the corner or side to crop it similar to crop works in power point.

Edit should work only when full resolution original image is displayed and after editing, it should recreate thumbnail immediately as part of save or save as copy process.

In main photo screen

1. We want to tidy up the top toolbar so it fits in one line.
   1. Remove second green chip of library name i.e. for one drive photo we have title as onedrivephotos and again gree button showing same onedrivephots, we need just title here.
   2. We have buttons for select, clean duplicate, Rescan and ask AI which we can convert into just icons only on button and tooltip with description on mouse hover.

Still overall navigation and escape key is not handled properly, we need to track the screen so when escape key is pressed, it woud get back user to exactl previous screen from where user has clicked to open new screen.

In settings,

1. We are having two section relating to smart flow i.e. smartflow cloud fallback and local model, please merge this both as single section with heading "Smart flow configuration".

In main photo screen, when I select multiple photo and click on button edit date/location, it shows the popup with name and map button. Now If user opens the map, it shows popup with map and google link and name on that, if user paste the google link and enter some name and click on use this location, specifically name entered here is not updated on previous popup and still update button is enabled. Please mofidy so that name entered on map popup should be updated back in previous popup and button to update should be disabled and there should be clear indication that user need to add Location name in the textbox.

In main photo page, when we select multiple photo and add to album, we need to select first album and then it should show the chapters of that album to select from, if user do not select any chapter and press enter, all the photo should be added to chapter others.

It seems that information returned from local model is associated with wrong image, can you please check and confirm.

When I rename location for multiple photo for example I have selected photos taken in aldaman and rename to 'Andaman' but it renames to 'Andaman, India' which should not be. Then I go to photos and 'Ask AI', I tried to search photo of sachin at #andaman where place shown as andaman, India which i have selected but now again it shows 15000 photo and it shows location name as 'India' only.

In search with AI, can it understand "Only photo of monika at #andaman"

or "Photo of stavan and stuti only" or "photo of monika but not raji"

Need two major feature update

1. Can we develop background task similar to thumbnail generation to extract the description and tag using local model running in ollama, this might help us to use 'Search with AI' more effectively.
2. Handle Video as thumbnail, need to scan folder for video files and create thumbnail for that video, show separate overalay icon to show that this is video and on click open video player to run that video. We need to generate preview video like few snaps (may be 10 to 20) and create small video which should be played inline in galary when mouse is placed and kept for 2 second.

Need search box in people and place page to filter.

In main photo screen

1. When we select one photo using checkbox, we can choose the other photos by just clicking on anywhere on photo. Now problem is if I want to see it full screen, I need to deselect everything. We can improve this by adding one more overlay button on photo to see full screen when selection process is going on.

In duplicate removal feature,

1. We need selection on top that we want to find exact equal photo i.e. file size and dimention of photos are exactly equal or we want to find similar photos what we are doing currently.

In network storage

1. In network storage settings, We need to show the status of caching (x out of y), face detection (x photos out of y, z faces detected) and AI Description (x out of y photos), please redesign and show the numbers.
2. Same things we should show in left side navigation card of that network storage with simple Cache:x/y, Face:x/y, AI:x/y kind of notation.
3. We need to show wait message for all the lengthy main thread operations and if possible along with progress bar so user do not feel that application is hand.
4. In Album list, we need search textbox.
5. In photo detail page, we have link to select on map, which shows text input to paste google link and use link button. We need one more button right to use this link to open google map in browser with current name to search.
6. In places, when we click photo, when we click on bunch of photo, it show correct location button. On click of this button we open correct location dialogbox which we need to change and use the same dialogbox "set location on map".

AI Search

1. should support and understand keywords like OR, AND, NOT etc. For example when I search &bird or &birds it should show photo of single bird or multple birds but currently it gives zero result.
2. In local model based AI info extraction, which we are shoing in photo detail page, we need to give edit or deleting the description or Tags.
3. It should be possible to select multiple photos and edit AI Info similar to date and location, rename this top toolbar button to Edit Info and include all three in that dialogbox.


In person, photo display page

1. Need button to mark all as correct or mark all as not correct in top toolbar.
2. When I move the mouse over photo, it should show overlay button on top right corner to show a. Full Thumbnail b. Zoomed Thumbnail c. Full Original Photo d. zoomed oroignal photo e. mark this as cover photo for person. All should be small icon and tooltip to show the exact functionality.
3. When I click to open the full screen photo detail, we should highlight photo of selected person from where we came in different color of marking so user can immdeatily notice it.
4. In bottom of the photo where we are showing yes and no button, should have link on name of photo to open that photo in windows explorer.
5. 



1. When we open photo default shold be 'do not show photo marker', photo view in fill mode and if disk is not cloud drive show full resolution photo.
2. While deleting photo using AI best shot, it stall the application, please add the wait dialogbox until delete opetion is completed so user can understand there is operation going on in background. Ensure that when we delete the photo, we remove the cached image, remove related data in database also.
3. If user has selected photo from galary and click on "Find best shot", after completing operation, it shold close the dialogbox and back to photo galary.


20261007

1. How to manage people who are not recognised by software like person showing back of him towards camera but I want to tag him but do not want system to use that face data to recognize in other photo. suggest whether I should mark it as person backside of him or we should add some feature to capture hidden faces in the photo which can be used for searching.
2. Want to make two pane file explorer kind with toolbar having buttons in middle to move photos between folder. It should have two pane windows style explorer with showing top toolbar similar to main photolist, showing thumbnail in main content area and buttons in middle vertical toolbar to move one or all selected photo to either side.
   1. This should have functionality to do this offline and after all the virtual movement of photos of videos, user will have commit button.
   2. In case afrer commit, storage is not online, it will queue all the commits action and execute when storage becomes online.
